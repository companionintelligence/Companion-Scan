/**
 * A Place's georeference reaching its world, through the real server: how a new world places scans, what saving a georeference
 * does to a world, what it never does, and the seed the Place location panel offers.
 *
 * The pure decisions are world_origin.test.ts's and are checked there against a physical model; this is that code as wired into
 * `scanManifestFromStored`, `synthesizeWorld` and `refreshWorldScans`, reading sidecars from disk and a registry from a file:
 *
 *  1. A new world declares the right-handed scene, its origin is the best-accuracy located scan, and an uncalibrated scan is
 *     placed by its fix and the session compass, or stands on the grid, naming why, with a stamp either way.
 *  2. Saving a georeference through the route places the world's unpatched scans again on the next read, flags the ones a person
 *     moved without moving them, moves what "reset to calibrated" returns to, and does it once: a read again changes nothing.
 *  3. A world file the previous build wrote (it declares z north) is converted by the first georeference, and not before.
 *  4. The seed: a Place's scans, from different start headings, give the Place's true bearing and its landmark's position.
 *  5. What a stored sidecar from the previous build, with no session record, is placed as: on the grid in a new world.
 */
import { assert, assertAlmostEquals, assertEquals, assertNotEquals } from './assert.ts'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { enuToGeodetic, sceneFromEnu } from '../../../src/world/enu.ts'
import { twoPointToProjectTransform } from '../../../src/world/geo.ts'
import { buildGeoreference } from '../../../src/world/georef.ts'
import type { GeoSession } from '../../../src/world/geo-session.ts'
import type { EditPatch, Project, ProjectGeoreference, ScanManifest, WorldProject } from '../../../src/world/types.ts'
import { gridMatrix, multiplyColumnMajor, placeCalibratedScan } from '../../../server/world/world_origin.ts'
import { composeYUpTransform } from '../../../src/world/geo.ts'
import { type RunningServer, readWorld, startServer, writeScan } from './georef_server_support.ts'
import { FIRST_SCANS, HEADING_MARKER, LANDMARK, PROJECT_TRANSFORM, sidecarOf } from './world_placement_fixtures.ts'
import { angDiff, applyColumnMajor, bearingOfEnu, enuToSession, type Enu, trueSessionZBearing, type V3 } from './physical_oracle.ts'
import * as fs from 'node:fs/promises'
import { test } from 'node:test'
import { readBytes } from '../../../server/fs_util.ts'
import { serveFetch } from './http_server.ts'

const LONDON = { lat: 51.5007, lng: -0.1246 }
const START = '2026-11-01T10:00:00.000Z'
const STARTED_MS = Date.parse(START)
const FLOORS = [{ floorId: 'floor-1', name: 'Ground Floor', level: 0, rooms: [{ roomId: 'room-1', name: 'Kitchen' }] }]

const PLACE: Record<string, unknown> = {
  projectId: 'proj-1',
  name: 'Kitchen',
  placeType: 'room',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
  areas: [{ areaId: 'area-site', name: 'Kitchen', kind: 'site', parentAreaId: null }],
  floors: FLOORS,
  spatialFrame: {
    version: 1,
    createdAt: '2026-10-31T09:00:00.000Z',
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: 2 },
    separationM: 2,
    toleranceM: 0.15,
    anchorBearingDeg: null,
  },
  spatialFrameRevision: 1,
}

const georef = (bearingDeg: number, extra: Partial<ProjectGeoreference> = {}): ProjectGeoreference => ({
  ...buildGeoreference({ ...LONDON, originAccuracyM: 3.5, bearingDeg, bearingAccuracyDeg: 1, source: 'map-click', anchorRef: null, now: new Date('2026-11-17T10:00:00Z'), confirmed: true }),
  ...extra,
})

function geoSession(bearingDeg: number | null, extra: Partial<GeoSession> = {}): GeoSession {
  return {
    v: 1,
    startedAt: START,
    fix: { offsetS: 8, sessionX: null, sessionZ: null },
    bearing: bearingDeg === null ? null : { deg: bearingDeg, spreadDeg: 4, sigmaDeg: 15, samples: 30, spanS: 9, source: 'android-absolute' },
    declination: { deg: 1.2, model: 'WMM2025', year: 2026.84 },
    ...extra,
  }
}

/** A sidecar of Place `proj-1`, with a fix `east` and `north` metres from LONDON, and a session record. */
function placed(name: string, east: number, north: number, accuracy: number, session: GeoSession | null, calibration: Record<string, unknown> | null = null, fixedSecondsAfterStart = 8): Record<string, unknown> {
  const at = enuToGeodetic({ ...LONDON, altitudeM: 0 }, { east, north, up: 0 })
  return {
    ...sidecarOf(name, { lat: at.lat, lng: at.lng, accuracy, altitudeM: 12.5, bearing: 321, fixedAt: new Date(STARTED_MS + fixedSecondsAfterStart * 1000).toISOString() }, calibration),
    projectId: 'proj-1',
    ...(session ? { geoSession: session } : {}),
  }
}

const TWO_POINT = {
  method: 'two-point-ground',
  sessionToProject: PROJECT_TRANSFORM,
  separationM: 2.4,
  residualM: 0.02,
  toleranceM: 0.15,
  anchorBearingDeg: 81.5,
  calibratedAt: '2026-11-01T10:00:00.000Z',
  status: 'verified',
}

const T0 = Date.parse('2026-11-01T10:00:00.000Z')
const at = (minutes: number) => T0 + minutes * 60_000
const byName = (world: WorldProject, name: string): ScanManifest => {
  const scan = world.scans.find((candidate) => candidate.name === name)
  assert(scan, `no scan named ${name}: ${world.scans.map((s) => s.name).join(', ')}`)
  return scan
}
const WORLD = '/projects/proj-1/world'

async function putGeoreference(server: RunningServer, record: ProjectGeoreference, expectedVersion: number): Promise<number> {
  const reply = await server.send('PUT', '/projects/proj-1/georeference', { georeference: record, expectedVersion })
  assertEquals(reply.status, 200, reply.text)
  return (reply.json as { georefVersion: number }).georefVersion
}

// ── 1. A new world ───────────────────────────────────────────────────────────

test('a new world declares the scene, takes its origin from the best-accuracy scan, and places a scan by its fix and compass, or on the grid saying why', async () => {
    // The newest scan (`newest-poor`) has the worst fix: a world that took its origin from it would be 60 m from its building.
    const physical: Enu = { east: 30, north: -12, up: 0 }
    const psi = 137
    const server = await startServer({}, {
      seed: [PLACE],
      scans: async (dir) => {
        const scans: Array<[string, Record<string, unknown>, number]> = [
          ['cal', placed('cal', 5, 5, 6, geoSession(null), TWO_POINT), at(1)],
          ['gps-best', placed('gps-best', 0, 0, 3, geoSession(trueSessionZBearing(psi))), at(2)],
          ['gps-site', placed('gps-site', physical.east, physical.north, 7, geoSession(trueSessionZBearing(psi))), at(3)],
          ['gps-poor', placed('gps-poor', 4, 4, 40, geoSession(90)), at(4)],
          ['gps-old-fix', placed('gps-old-fix', 8, 8, 5, geoSession(90), null, -200), at(5)],
          ['gps-no-bearing', placed('gps-no-bearing', 8, 8, 5, geoSession(null)), at(6)],
          ['gps-scattered', placed('gps-scattered', 8, 8, 5, geoSession(90, { bearing: { deg: 90, spreadDeg: 31, sigmaDeg: 31, samples: 30, spanS: 9, source: 'android-absolute' } })), at(7)],
          ['gps-previous-build', placed('gps-previous-build', 9, 9, 5, null), at(8)],
          ['gps-far', placed('gps-far', 900, 0, 5, geoSession(90)), at(9)],
          ['no-fix', { ...sidecarOf('no-fix', null, null), projectId: 'proj-1' }, at(10)],
          ['newest-poor', placed('newest-poor', 3, 3, 60, geoSession(90)), at(11)],
        ]
        for (const [name, meta, mtime] of scans) await writeScan(dir, name, meta, mtime)
      },
    })
    try {
      const world = await readWorld(server, WORLD)
      // A new world is the right-handed scene; its origin is the best accuracy, not the newest.
      assertEquals(world.localFrame.axes, { x: 'east', y: 'up', z: 'south' })
      assertEquals(world.originGeoPose.accuracyM, 3)
      assertAlmostEquals(world.originGeoPose.lat!, LONDON.lat, 1e-9)
      assertEquals(world.georeference, undefined, 'the Place has none')
      assertEquals(world.georefVersion, undefined)

      // A calibrated scan of a Place with no georeference: at its projectTransform as it is, in the Place frame.
      const cal = byName(world, 'cal')
      assertEquals(cal.localToWorld, PROJECT_TRANSFORM.map((n) => n + 0))
      assertEquals([cal.placementSource, cal.placementUncertaintyM], ['place-frame', null])

      // A scan placed by its fix and the session compass: every feature lands where the oracle says.
      const site = byName(world, 'gps-site')
      assertEquals(site.placementSource, 'gps-compass')
      assertEquals(site.placementUncertaintyM, 10, 'a fix of 7 m is claimed at 10')
      const featureEnu: Enu = { east: 2, north: 3, up: 0.5 }
      const got = applyColumnMajor(site.localToWorld, enuToSession(psi, featureEnu))
      const want = sceneFromEnu({ east: physical.east + featureEnu.east, north: physical.north + featureEnu.north, up: featureEnu.up })
      assertAlmostEquals(Math.hypot(got.x - want.x, got.y - want.y, got.z - want.z), 0, 1e-6)
      assertEquals(site.localToWorld[13], 0, 'the height is the Place floor, never the 12.5 m the phone said')

      // Each gate: on the grid, in its own slot, unturned, with the stamp that says so.
      const index = (name: string) => world.scans.findIndex((scan) => scan.name === name)
      for (const name of ['gps-poor', 'gps-old-fix', 'gps-no-bearing', 'gps-scattered', 'gps-previous-build', 'gps-far', 'no-fix', 'newest-poor']) {
        const scan = byName(world, name)
        assertEquals(scan.localToWorld, gridMatrix(index(name)), `${name} stands on the grid`)
        assertEquals([scan.placementSource, scan.placementUncertaintyM], ['grid', null], name)
      }
      assertEquals(byName(world, 'gps-far').geoOutlier, true)
      assertEquals(byName(world, 'gps-best').placementSource, 'gps-compass')
      // The best scan is at the origin.
      assertAlmostEquals(byName(world, 'gps-best').localToWorld[12]!, 0, 1e-6)

      // And a read again changes nothing: the placement is frozen once made.
      const again = await readWorld(server, WORLD)
      assertEquals(again.scans.map((scan) => [scan.name, scan.localToWorld, scan.placementSource]), world.scans.map((scan) => [scan.name, scan.localToWorld, scan.placementSource]))
    } finally {
      await server.stop()
    }
  })

test('a scan added to a new world is placed the same way, and a world that began with no located scan takes the origin of the first one', async () => {
    const server = await startServer({}, {
      seed: [PLACE],
      scans: async (dir) => {
        await writeScan(dir, 'first-no-fix', { ...sidecarOf('first-no-fix', null, null), projectId: 'proj-1' }, at(1))
      },
    })
    try {
      const first = await readWorld(server, WORLD)
      assertEquals(first.originGeoPose.lat, null, 'no scan had a fix')
      assertEquals(byName(first, 'first-no-fix').placementSource, 'grid')
      const standing = byName(first, 'first-no-fix').localToWorld

      await writeScan(server.scansDir, 'later', placed('later', 20, 10, 5, geoSession(200)), at(2))
      const second = await readWorld(server, WORLD)
      assertAlmostEquals(second.originGeoPose.lat!, LONDON.lat + 0, 0.01, 'the first scan with a fix is the origin')
      const later = byName(second, 'later')
      assertEquals(later.placementSource, 'gps-compass', 'placed against it')
      assertEquals(byName(second, 'first-no-fix').localToWorld, standing, 'and what stood on the grid did not move')
      // A second located scan is placed against the origin that was latched, not a new one.
      await writeScan(server.scansDir, 'later-2', placed('later-2', 21, 10, 3, geoSession(200)), at(3))
      const third = await readWorld(server, WORLD)
      assertEquals(third.originGeoPose, second.originGeoPose)
      assertEquals(byName(third, 'later').localToWorld, later.localToWorld)
    } finally {
      await server.stop()
    }
  })

// ── 2. A georeference reaches the world ──────────────────────────────────────

test('saving a georeference places the unpatched scans again on the next read, flags the ones a person moved without moving them, and does it once', async () => {
    const server = await startServer({}, {
      seed: [PLACE],
      scans: async (dir) => {
        await writeScan(dir, 'cal-a', placed('cal-a', 5, 5, 6, geoSession(null), TWO_POINT), at(1))
        await writeScan(dir, 'cal-b', placed('cal-b', 5, 5, 6, geoSession(null), TWO_POINT), at(2))
        await writeScan(dir, 'gps-c', placed('gps-c', 12, -3, 5, geoSession(250)), at(3))
        await writeScan(dir, 'gps-d', placed('gps-d', -9, 4, 5, geoSession(250)), at(4))
      },
    })
    try {
      const before = await readWorld(server, WORLD)
      const cb = byName(before, 'cal-b')
      const gd = byName(before, 'gps-d')

      // A person moves two scans by hand: a patch is the editor's only way, an absolute matrix.
      const moved = (matrix: number[]) => composeYUpTransform({ x: matrix[12]! + 7, y: 0, z: matrix[14]! - 2 }, 33, 1)
      for (const scan of [cb, gd]) {
        const body = { scope: 'scan', scanId: scan.scanId, targetId: scan.filename, transform: { matrix: moved(scan.localToWorld) } }
        const reply = await server.send('POST', `/worlds/${before.shareSlug}/patches`, body, { token: before.members.find((m) => m.role === 'owner')?.token ?? '' })
        // The member tokens are redacted for an anonymous read: the owner token is in the world file.
        if (reply.status !== 200 && reply.status !== 201) {
          const file = await server.worldFile(before.shareSlug)
          const owner = file.members.find((m) => m.role === 'owner')!.token
          const retry = await server.send('POST', `/worlds/${before.shareSlug}/patches`, body, { token: owner })
          assert(retry.status === 200 || retry.status === 201, `patch: ${retry.status} ${retry.text}`)
        }
      }
      const patched = await readWorld(server, WORLD)
      assertEquals(byName(patched, 'cal-b').localToWorld, moved(cb.localToWorld), 'the patches moved them')

      // Saved: a georeference, version 1.
      const record = georef(75)
      assertEquals(await putGeoreference(server, record, 0), 1)
      const after = await readWorld(server, WORLD)

      assertEquals(after.localFrame.axes.z, 'south')
      assertEquals(after.georefVersion, 1)
      assertEquals(after.georeference, record)
      assertAlmostEquals(after.originGeoPose.lat!, LONDON.lat, 1e-12)
      assertEquals(after.originGeoPose.accuracyM, 3.5)

      // Unpatched calibrated: through the georeference, stamped, and what it started as follows.
      const a = byName(after, 'cal-a')
      assertEquals(a.localToWorld, placeCalibratedScan(record, LONDON, PROJECT_TRANSFORM))
      assertNotEquals(a.localToWorld, byName(before, 'cal-a').localToWorld)
      assertEquals(a.placementSource, 'georeference')
      assert(typeof a.placementUncertaintyM === 'number' && a.placementUncertaintyM >= 3.5)
      assertEquals(a.calibratedLocalToWorld, a.localToWorld)
      assertEquals(a.placementStale, undefined)
      // Unpatched uncalibrated: placed against the georeference's origin.
      const c = byName(after, 'gps-c')
      assertEquals(c.placementSource, 'gps-compass')
      assertAlmostEquals(c.localToWorld[12]!, 12, 1e-6)
      assertAlmostEquals(c.localToWorld[14]!, 3, 1e-6)

      // Patched: exactly where the person left them, flagged, with the new placement to go back to.
      const b = byName(after, 'cal-b')
      assertEquals(b.localToWorld, moved(cb.localToWorld))
      assertEquals(b.placementStale, true)
      assertEquals(b.calibratedLocalToWorld, a.localToWorld)
      assertEquals(byName(after, 'gps-d').localToWorld, moved(gd.localToWorld))
      assertEquals(byName(after, 'gps-d').placementStale, true)

      // Once: a read again is the same, byte for byte, and writes nothing new.
      const file = await server.worldFile(after.shareSlug)
      const again = await readWorld(server, WORLD)
      assertEquals(again.scans.map((scan) => scan.localToWorld), after.scans.map((scan) => scan.localToWorld))
      assertEquals((await server.worldFile(after.shareSlug)).updatedAt, file.updatedAt, 'the world file was not rewritten by a read that changed nothing')

      // A new version: the unpatched follow it, the moved stay, and a scan that arrives is placed through the new record.
      const turned = georef(200, { registeredAt: '2026-11-17T11:00:00.000Z', confirmedAt: '2026-11-17T11:00:00.000Z' })
      assertEquals(await putGeoreference(server, turned, 1), 2)
      await writeScan(server.scansDir, 'cal-late', placed('cal-late', 5, 5, 6, geoSession(null), TWO_POINT), at(30))
      const next = await readWorld(server, WORLD)
      assertEquals(next.georefVersion, 2)
      assertEquals(byName(next, 'cal-a').localToWorld, placeCalibratedScan(turned, LONDON, PROJECT_TRANSFORM))
      assertEquals(byName(next, 'cal-late').localToWorld, placeCalibratedScan(turned, LONDON, PROJECT_TRANSFORM), 'a scan added now is placed through the record')
      assertEquals(byName(next, 'cal-late').placementSource, 'georeference')
      assertEquals(byName(next, 'cal-b').localToWorld, moved(cb.localToWorld), 'and the one a person moved still has not moved')
      assertEquals(byName(next, 'cal-b').placementStale, true)
      assertEquals(byName(next, 'cal-b').calibratedLocalToWorld, byName(next, 'cal-a').localToWorld)
    } finally {
      await server.stop()
    }
  })

test('the placement through a georeference puts every feature of two sessions with different start headings where a physical model does, to 1e-9 m', async () => {
    const landmarkAt: Enu = { east: 0, north: 0, up: 0 }
    const markerAt: Enu = { east: 2.4, north: 1.9, up: 0 }
    const bearing = bearingOfEnu({ east: markerAt.east, north: markerAt.north })
    const sessions = [{ psi: 10, origin: { east: -1.5, north: -2, up: 0 } }, { psi: 137, origin: { east: 3.5, north: 1, up: 0 } }, { psi: 290, origin: { east: -4, north: 6, up: 0 } }]
    const server = await startServer({}, {
      seed: [PLACE],
      scans: async (dir) => {
        for (const [i, s] of sessions.entries()) {
          const rel = (p: Enu): V3 => enuToSession(s.psi, { east: p.east - s.origin.east, north: p.north - s.origin.north, up: p.up - s.origin.up })
          const landmark = rel(landmarkAt)
          const marker = { ...rel(markerAt), y: landmark.y }
          await writeScan(dir, `session-${i}`, placed(`session-${i}`, 0, 0, 5, geoSession(null), { ...TWO_POINT, sessionToProject: twoPointToProjectTransform(landmark, marker) }), at(i + 1))
        }
      },
    })
    try {
      await readWorld(server, WORLD)
      await putGeoreference(server, georef(bearing, { source: 'survey', origin: { ...LONDON, altitudeM: null, accuracyM: 0.05 }, bearingAccuracyDeg: 0.1 }), 0)
      const world = await readWorld(server, WORLD)
      const features: Enu[] = [{ east: 3, north: 0, up: 0.5 }, { east: -2, north: -3, up: 0 }, { east: 2, north: 2, up: 2 }]
      let worst = 0
      for (const [i, s] of sessions.entries()) {
        const rel = (p: Enu): V3 => enuToSession(s.psi, { east: p.east - s.origin.east, north: p.north - s.origin.north, up: p.up - s.origin.up })
        const scan = byName(world, `session-${i}`)
        assertEquals(scan.placementSource, 'georeference')
        for (const f of features) {
          const got = applyColumnMajor(scan.localToWorld, rel(f))
          const want = sceneFromEnu(f)
          worst = Math.max(worst, Math.hypot(got.x - want.x, got.y - want.y, got.z - want.z))
        }
      }
      assert(worst < 1e-9, `worst ${worst} m`)
    } finally {
      await server.stop()
    }
  })

test('a calibrated scan that arrives after the georeference is carried by it, and "reset to calibrated" returns it there', async () => {
    const server = await startServer({}, {
      seed: [PLACE],
      scans: async (dir) => {
        await writeScan(dir, 'cal-early', placed('cal-early', 5, 5, 6, geoSession(null), TWO_POINT), at(1))
      },
    })
    try {
      await readWorld(server, WORLD)
      const record = georef(75)
      assertEquals(await putGeoreference(server, record, 0), 1)
      await readWorld(server, WORLD)

      // A phone uploads another scan of the same frame.
      await writeScan(server.scansDir, 'cal-late', placed('cal-late', 6, 4, 5, geoSession(null), TWO_POINT), at(2))
      const world = await readWorld(server, WORLD)
      const late = byName(world, 'cal-late')
      // Where the georeference carries a calibration of this frame: the Place frame turned onto the map, the Place's origin the scene's.
      const carried = placeCalibratedScan(record, record.origin, PROJECT_TRANSFORM).map((n) => n + 0)
      assertEquals(late.placementSource, 'georeference')
      assertEquals(late.localToWorld, carried)
      assertEquals(late.calibratedLocalToWorld, carried, 'reset to calibrated returns to where the georeference puts it, not to the Place frame as it is')
      assertNotEquals(late.calibratedLocalToWorld, PROJECT_TRANSFORM.map((n) => n + 0))
    } finally {
      await server.stop()
    }
  })

// ── 3. A world the previous build wrote ──────────────────────────────────────

const GOLDEN = JSON.parse(await fs.readFile(new URL('./fixtures/world-placement-golden.json', import.meta.url), 'utf8')) as {
  legacyWorldFile: WorldProject
  afterFirstRead: Record<string, { localToWorld: number[]; calibratedLocalToWorld: number[] | null }>
}

/** The golden's legacy world, as the world of Place `proj-1`: the same eight scans, the same frozen matrices, declared z north. */
function legacyPlaceWorld(patches: EditPatch[] = []): string {
  const world = JSON.parse(JSON.stringify(GOLDEN.legacyWorldFile)) as WorldProject
  world.worldId = 'world-project-proj-1'
  world.shareSlug = 'project-proj-1'
  world.name = 'Kitchen'
  world.projectId = 'proj-1'
  for (const scan of world.scans) scan.projectId = 'proj-1'
  world.editPatches = patches
  // A saved move is both a patch in the log and the matrix on the row (`applyPatchToWorld`): the file holds both.
  for (const patch of patches) {
    const scan = world.scans.find((candidate) => candidate.scanId === patch.scanId)
    if (scan) scan.localToWorld = patch.transform!.matrix!
  }
  return JSON.stringify(world)
}

test('a world file the previous build wrote keeps its placements and its z north until the Place is given a georeference, which converts it', async () => {
    // A person had moved one calibrated scan and one GPS scan before the update.
    const patch = (name: string, scanId: string, matrix: number[]): EditPatch => ({
      patchId: `patch-${name}`,
      worldId: 'world-project-proj-1',
      scanId,
      targetId: `${name}.glb`,
      scope: 'scan',
      transform: { matrix, position: { x: matrix[12]!, y: matrix[13]!, z: matrix[14]! }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
      actorId: 'tester',
      createdAt: '2026-11-02T00:00:00.000Z',
    })
    const handMoved = composeYUpTransform({ x: 40, y: 0, z: 40 }, 15, 1)
    const server = await startServer({}, {
      seed: [PLACE],
      worlds: { 'project-proj-1': legacyPlaceWorld([patch('cal-one', 'scan-cal-one', handMoved), patch('gps-nullalt', 'scan-gps-nullalt', handMoved)]) },
      scans: async (dir) => {
        for (const scan of FIRST_SCANS) await writeScan(dir, scan.name, { ...scan.meta, projectId: 'proj-1' }, scan.mtimeMs)
      },
    })
    try {
      // 1. Read: nothing moves. The world is the legacy one it was, every matrix is the golden's, and no georeference is in it.
      const legacy = await readWorld(server, WORLD)
      assertEquals(legacy.localFrame.axes.z, 'north')
      assertEquals(legacy.georeference, undefined)
      for (const scan of legacy.scans) {
        const want = scan.name === 'cal-one' || scan.name === 'gps-nullalt' ? handMoved : GOLDEN.afterFirstRead[scan.name]!.localToWorld
        assertEquals(scan.localToWorld, want, `${scan.name} is where it was`)
      }
      // The calibrated scans carry the one stamp that can be proved (they sit exactly at their projectTransform), and the GPS ones none.
      assertEquals(byName(legacy, 'cal-two').placementSource, 'place-frame')
      assertEquals(byName(legacy, 'gps-good').placementSource, undefined)

      // 2. A georeference: the world is the scene now.
      const record = georef(75)
      assertEquals(await putGeoreference(server, record, 0), 1)
      const converted = await readWorld(server, WORLD)
      assertEquals(converted.localFrame.axes.z, 'south')
      assertEquals(converted.georefVersion, 1)
      // Unpatched calibrated: through the record. Unpatched with no session record (the previous build had none): on the grid, since
      // nothing says which way the session faced.
      assertEquals(byName(converted, 'cal-two').localToWorld, placeCalibratedScan(record, LONDON, PROJECT_TRANSFORM))
      assertEquals(byName(converted, 'cal-two').placementSource, 'georeference')
      for (const name of ['gps-good', 'gps-poor', 'gps-nobearing', 'gps-outlier', 'no-fix']) {
        const scan = byName(converted, name)
        assertEquals(scan.placementSource, 'grid', name)
        assertEquals(scan.localToWorld, gridMatrix(converted.scans.indexOf(scan)), name)
      }
      // Patched: exactly where the person left them. The GPS scan is flagged and told where the record would put it (the grid, for want
      // of a compass record); the one-point scan is in another frame than the Place's two-point one, which no georeference carries, so
      // there is nothing about it that is out of date.
      const gps = byName(converted, 'gps-nullalt')
      assertEquals(gps.localToWorld, handMoved, 'the moved GPS scan did not move')
      assertEquals(gps.placementStale, true, 'and is flagged')
      assertNotEquals(gps.calibratedLocalToWorld, GOLDEN.afterFirstRead['gps-nullalt']!.calibratedLocalToWorld, 'reset goes to the new placement')
      assertEquals(gps.calibratedLocalToWorld, gridMatrix(converted.scans.indexOf(gps)))
      const one = byName(converted, 'cal-one')
      assertEquals(one.localToWorld, handMoved, 'the moved one-point scan did not move')
      assertEquals(one.placementStale, undefined, 'and is not stale: the georeference never carried it')
      assertEquals(one.calibratedLocalToWorld, GOLDEN.afterFirstRead['cal-one']!.calibratedLocalToWorld, 'its calibrated placement is what it was')
      // The patches themselves are untouched: the log of what people did is not rewritten.
      assertEquals(converted.editPatches.map((p) => p.patchId), ['patch-cal-one', 'patch-gps-nullalt'])
    } finally {
      await server.stop()
    }
  })

// ── 4. The seed ──────────────────────────────────────────────────────────────

test('the compass estimate of a Place: its scans from different start headings give its true bearing and its landmark, and only the scans of its frame count', async () => {
    // The landmark is at LONDON; the marker 2.4 m east and 1.9 m north of it: the Place's true bearing is that direction.
    const landmarkAt: Enu = { east: 0, north: 0, up: 0 }
    const markerAt: Enu = { east: 2.4, north: 1.9, up: 0 }
    const truth = bearingOfEnu({ east: markerAt.east, north: markerAt.north })
    // Each session starts somewhere facing somewhere, walks to a spot where its best fix was taken (the camera was there), and its compass is perfect.
    // Session c has an iPhone's compass, which is never claimed better than 25 degrees; the Place is of frame generation `frame-a`.
    const sessions = [
      { name: 'a', psi: 10, origin: { east: -1.5, north: -2, up: 0 }, camera: { x: 4, z: 6 }, accuracy: 12, ios: false, frameId: 'frame-a' },
      { name: 'b', psi: 137, origin: { east: 3.5, north: 1, up: 0 }, camera: { x: -2, z: 9 }, accuracy: 6, ios: false, frameId: undefined },
      { name: 'c', psi: 290, origin: { east: -4, north: 6, up: 0 }, camera: { x: 0.5, z: 0.5 }, accuracy: 9, ios: true, frameId: undefined },
    ]
    /** What each session's fix is worth as the landmark, worked out here from the ground rules: the reported accuracy as a seed claims it, and the walk back to the landmark, which adds the bearing's error over the distance. */
    const originAccuracies: number[] = []
    const server = await startServer({}, {
      seed: [{ ...PLACE, spatialFrame: { ...(PLACE['spatialFrame'] as Record<string, unknown>), frameId: 'frame-a' } }],
      scans: async (dir) => {
        for (const [i, s] of sessions.entries()) {
          const rel = (p: Enu): V3 => enuToSession(s.psi, { east: p.east - s.origin.east, north: p.north - s.origin.north, up: p.up - s.origin.up })
          const landmark = rel(landmarkAt)
          const marker = { ...rel(markerAt), y: landmark.y }
          // The camera at the fix is at session (x, z): its physical position is the session origin plus that, turned by the session's bearing.
          const bz = trueSessionZBearing(s.psi)
          const cameraEnu = { east: s.origin.east + s.camera.z * Math.sin((bz * Math.PI) / 180) - s.camera.x * Math.cos((bz * Math.PI) / 180), north: s.origin.north + s.camera.z * Math.cos((bz * Math.PI) / 180) + s.camera.x * Math.sin((bz * Math.PI) / 180) }
          const session = geoSession(bz, {
            fix: { offsetS: 20, sessionX: s.camera.x, sessionZ: s.camera.z },
            ...(s.ios ? { bearing: { deg: bz, spreadDeg: 4, sigmaDeg: 25, samples: 30, spanS: 9, source: 'ios-compass' as const } } : {}),
          })
          await writeScan(dir, `seed-${s.name}`, { ...placed(`seed-${s.name}`, cameraEnu.east, cameraEnu.north, s.accuracy, session, { ...TWO_POINT, sessionToProject: twoPointToProjectTransform(landmark, marker) }), ...(s.frameId ? { calibrationFrameId: s.frameId } : {}) }, at(i + 1))
          const reported = s.accuracy <= 10 ? 10 : Math.max(s.accuracy * 1.5, 25)
          const walked = Math.hypot(landmark.x - s.camera.x, landmark.z - s.camera.z)
          const bearingSigma = s.ios ? 25 : 15
          originAccuracies.push(walked > 3 ? Math.hypot(reported, walked * ((bearingSigma * Math.PI) / 180)) : reported)
        }
        // Not of this Place's frame: a one-point scan (another frame), a scan of an earlier generation of the frame, and a scan with no compass record.
        await writeScan(dir, 'seed-one-point', placed('seed-one-point', 0, 0, 5, geoSession(33), { method: 'ground-tap-compass', sessionToProject: PROJECT_TRANSFORM, anchorBearingDeg: 40, status: 'provisional' }), at(5))
        await writeScan(dir, 'seed-old-frame', { ...placed('seed-old-frame', 0, 0, 5, geoSession(77), { ...TWO_POINT, sessionToProject: PROJECT_TRANSFORM }), calibrationFrameId: 'frame-old' }, at(7))
        await writeScan(dir, 'seed-no-compass', placed('seed-no-compass', 0, 0, 5, null, TWO_POINT), at(6))
      },
    })
    try {
      const reply = await server.send('GET', '/projects/proj-1/georeference-seed')
      assertEquals(reply.status, 200, reply.text)
      const seed = reply.json as {
        bearing: { deg: number; spreadDeg: number; sigmaDeg: number; scans: number; lowConfidence: boolean } | null
        origin: { lat: number; lng: number; accuracyM: number } | null
        declination: { deg: number; model: string; year: number } | null
        considered: number
        used: number
      }
      assertEquals([seed.considered, seed.used], [6, 3], 'three scans of the Place frame had a bearing: not the one-point scan, the scan of an earlier frame generation, or the one with no compass')
      assertAlmostEquals(angDiff(seed.bearing!.deg, truth), 0, 1e-8, 'the true bearing of the Place frame +Z, from three starting headings')
      assert(seed.bearing!.spreadDeg < 1e-6, 'a perfect compass agrees with itself')
      assertEquals(seed.bearing!.sigmaDeg, 25, 'and is claimed no better than the worst compass among them can be: one is an iPhone\'s')
      assertEquals(seed.bearing!.scans, 3)
      assertEquals(seed.bearing!.lowConfidence, false)
      // The landmark: the best fix, carried back by where the camera was, through that session's own bearing. Every session
      // measured the same landmark, so the position is the same whichever is taken; how sure it is, is the best session's.
      assertAlmostEquals(seed.origin!.lat, LONDON.lat, 1e-9)
      assertAlmostEquals(seed.origin!.lng, LONDON.lng, 1e-9)
      assert(seed.origin!.accuracyM >= 10, `a seed's origin is claimed at 10 m or worse, not ${seed.origin!.accuracyM}`)
      assertAlmostEquals(seed.origin!.accuracyM, Math.min(...originAccuracies), 1e-9, `the best of ${originAccuracies.map((v) => v.toFixed(3)).join(', ')}, each from its reported accuracy and the distance walked back`)
      assert(new Set(originAccuracies.map((v) => v.toFixed(6))).size === 3, 'the three sessions are worth different amounts, so a wrong choice shows')
      assertEquals(seed.declination?.model, 'WMM2025')
      assertAlmostEquals(seed.declination!.deg, 1.2, 1e-12)

      // A Place with no scans, or none with a compass, has nothing to say, and says so.
      const empty = await server.send('GET', '/projects/proj-1/georeference-seed')
      assertEquals(empty.status, 200)
      assertEquals((await server.send('GET', '/projects/proj-0000000000/georeference-seed')).status, 404)
    } finally {
      await server.stop()
    }
  })

test('the compass estimate says nothing when there is nothing to say, and calls two scans low confidence', async () => {
    const server = await startServer({}, {
      seed: [PLACE, { ...PLACE, projectId: 'proj-2', name: 'Empty' }, { ...PLACE, projectId: 'proj-3', name: 'Poor fix' }],
      scans: async (dir) => {
        await writeScan(dir, 'only-a', placed('only-a', 0, 0, 5, geoSession(40), { ...TWO_POINT }), at(1))
        await writeScan(dir, 'only-b', placed('only-b', 0, 0, 5, geoSession(44), { ...TWO_POINT }), at(2))
        // A scan with a bearing and the camera's place at its fix, but a fix worse than 50 m: it can say which way, not where.
        await writeScan(dir, 'poor-fix', { ...placed('poor-fix', 0, 0, 60, geoSession(40, { fix: { offsetS: 8, sessionX: 1, sessionZ: 2 } }), { ...TWO_POINT }), projectId: 'proj-3' }, at(3))
      },
    })
    try {
      const none = (await server.send('GET', '/projects/proj-2/georeference-seed')).json as { bearing: unknown; origin: unknown; used: number }
      assertEquals([none.bearing, none.origin, none.used], [null, null, 0])
      const two = (await server.send('GET', '/projects/proj-1/georeference-seed')).json as { bearing: { lowConfidence: boolean; scans: number }; origin: unknown }
      assertEquals(two.bearing.scans, 2)
      assertEquals(two.bearing.lowConfidence, true, 'two scans are not enough to be confident')
      assertEquals(two.origin, null, 'no camera position at the fix: no landmark to give')
      const poor = (await server.send('GET', '/projects/proj-3/georeference-seed')).json as { bearing: { scans: number } | null; origin: unknown }
      assertEquals(poor.bearing?.scans, 1, 'the compass of the scan is used')
      assertEquals(poor.origin, null, 'a fix of 60 m says nothing about where the landmark is')
    } finally {
      await server.stop()
    }
  })

// ── 4b. The exports ──────────────────────────────────────────────────────────

test('the export job says where the Place is, or that nobody has said, and writes a GeoPose only when the job asks for it', async () => {
    const server = await startServer({}, {
      seed: [PLACE],
      scans: async (dir) => {
        await writeScan(dir, 'exp-a', placed('exp-a', 5, 5, 6, null, TWO_POINT), at(1))
      },
    })
    try {
      /** Runs an export job through the real queue and returns the scene extras of the file it wrote. */
      const exportExtras = async (payload?: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const queued = await server.send('POST', `/worlds/project-proj-1/jobs`, { type: 'export-world', ...(payload ? { payload } : {}) })
        assertEquals(queued.status, 202, queued.text)
        const jobId = (queued.json as { jobId: string }).jobId
        let status = ''
        for (let attempt = 0; attempt < 100 && status !== 'completed' && status !== 'failed'; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          status = (await readWorld(server, '/worlds/project-proj-1')).jobs.find((job) => job.jobId === jobId)?.status ?? ''
        }
        assertEquals(status, 'completed', server.log())
        const bytes = await readBytes(`${server.worldsDir}/project-proj-1.world.glb`)
        const document = await new NodeIO().registerExtensions(ALL_EXTENSIONS).readBinary(bytes)
        return document.getRoot().listScenes()[0]!.getExtras() as Record<string, unknown>
      }

      // A Place nobody has registered says so, in so many words: an explicit null, and no GeoPose even when asked for one.
      await readWorld(server, '/projects/proj-1/world')
      const unplaced = await exportExtras({ includeGeoPose: true })
      assertEquals(unplaced['georeference'], null)
      assertEquals(Object.hasOwn(unplaced, 'geopose'), false, 'a Place with no georeference has no pose to give')
      assertEquals((unplaced['axes'] as { z: string }).z, 'south')

      // With a georeference: the block is always there, the GeoPose only when the job asks.
      await putGeoreference(server, georef(30), 0)
      const plain = await exportExtras()
      const block = plain['georeference'] as { bearingDeg: number; origin: { lat: number; lng: number }; georefVersion: number; confirmedAt: string | null; crs: string }
      assertEquals([block.bearingDeg, block.origin.lat, block.origin.lng, block.georefVersion, block.crs], [30, LONDON.lat, LONDON.lng, 1, 'WGS84'])
      assertEquals(typeof block.confirmedAt, 'string')
      assertEquals(Object.hasOwn(plain, 'geopose'), false, 'GeoPose is off unless the job asks')
      const asked = await exportExtras({ includeGeoPose: true })
      const pose = (asked['geopose'] as { geopose: { position: { lat: number; lon: number; h: number }; quaternion: { x: number; y: number; z: number; w: number } } }).geopose
      assertEquals([pose.position.lat, pose.position.lon, pose.position.h], [LONDON.lat, LONDON.lng, 0])
      // The Place frame's +Z points 30 degrees east of north: a yaw of 180 - 30 = 150 degrees about the up axis, q = (0, 0, sin 75, cos 75).
      assertAlmostEquals(pose.quaternion.z, Math.sin((75 * Math.PI) / 180), 1e-12)
      assertAlmostEquals(pose.quaternion.w, Math.cos((75 * Math.PI) / 180), 1e-12)
      assertEquals(Object.hasOwn(await exportExtras({ includeGeoPose: 'yes' }), 'geopose'), false, 'only an explicit true asks')
    } finally {
      await server.stop()
    }
  })

test('the Companion Memory push says where the Place is: the georeference of its world, or an explicit null', async () => {
    // A stand-in for Companion Memory: it takes the upload and the event, and keeps the events.
    const events: Array<{ payload: { spatial_frame?: { georeference?: Record<string, unknown> | null } } }> = []
    const memory = await serveFetch(async (request) => {
      const path = new URL(request.url).pathname
      if (path === '/files/upload') {
        await request.formData().catch(() => null)
        return Response.json([{ id: 'file-1' }])
      }
      if (path === '/v1/events') {
        events.push(...((await request.json()) as { events: typeof events }).events)
        return Response.json({ ingested: 1, duplicate: 0, rejected: [] })
      }
      return new Response('not here', { status: 404 })
    })
    const server = await startServer({ CI_SERVER_URL: memory.url, CI_SERVER_TOKEN: 'test-token' }, {
      seed: [PLACE],
      scans: async (dir) => {
        await writeScan(dir, 'mem-a', placed('mem-a', 5, 5, 6, null, TWO_POINT), at(1))
      },
    })
    try {
      const pushOnce = async (): Promise<(typeof events)[number]> => {
        const world = await readWorld(server, '/projects/proj-1/world')
        // A push sends the scan off this server, so the server queues one only for an editor's token (the editor's share link) or a
        // Companion sign-in.
        const editor = (await server.worldFile('project-proj-1')).members.find((member) => member.role === 'editor')?.token
        const queued = await server.send('POST', '/worlds/project-proj-1/jobs', { type: 'memory-push', scanId: world.scans[0]!.scanId }, { token: editor })
        assertEquals(queued.status, 202, queued.text)
        const jobId = (queued.json as { jobId: string }).jobId
        const before = events.length
        let status = ''
        for (let attempt = 0; attempt < 100 && status !== 'completed' && status !== 'failed'; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          status = (await readWorld(server, '/projects/proj-1/world')).jobs.find((job) => job.jobId === jobId)?.status ?? ''
        }
        assertEquals(status, 'completed', server.log())
        assertEquals(events.length, before + 1)
        return events[events.length - 1]!
      }

      // A Place with no georeference says so, in so many words.
      const unplaced = await pushOnce()
      assertEquals(unplaced.payload.spatial_frame?.georeference, null)

      // With one: its block, with the true bearing of the Place frame's +Z and the version it was stored at.
      await putGeoreference(server, georef(30), 0)
      const placed1 = await pushOnce()
      const block = placed1.payload.spatial_frame?.georeference as { bearingDeg: number; origin: { lat: number; lng: number }; georefVersion: number; crs: string; confirmedAt: string | null }
      assertEquals([block.bearingDeg, block.origin.lat, block.origin.lng, block.georefVersion, block.crs], [30, LONDON.lat, LONDON.lng, 1, 'WGS84'])
      assertEquals(typeof block.confirmedAt, 'string')
    } finally {
      await server.stop()
      await memory.close()
    }
  })

// ── 5. Backward compatibility ────────────────────────────────────────────────

test('a Place from before the georeference, its world file, and the world answers of the previous build all keep loading', async () => {
    // The registry as the previous build saved it: no georeference, no version. The legacy world, written by that build.
    const server = await startServer({}, {
      seed: [PLACE],
      worlds: { 'project-proj-1': legacyPlaceWorld() },
      scans: async (dir) => {
        for (const scan of FIRST_SCANS) await writeScan(dir, scan.name, { ...scan.meta, projectId: 'proj-1' }, scan.mtimeMs)
      },
    })
    try {
      const place = (await server.send('GET', '/projects/proj-1')).json as Project
      assertEquals([place.georeference, place.georefVersion], [undefined, undefined])
      const world = await readWorld(server, WORLD)
      assertEquals(world.scans.length, 8)
      // The Place is still renamed and edited by clients that know nothing of the record, and the world still reads.
      const renamed = await server.send('PUT', '/projects/proj-1', { ...place, name: 'Kitchen, renamed' })
      assertEquals(renamed.status, 200, renamed.text)
      assertEquals((await readWorld(server, WORLD)).scans.length, 8)
    } finally {
      await server.stop()
    }
  })

// Used by the type checker only: the two sidecar helpers' shapes.
void LANDMARK
void HEADING_MARKER
void multiplyColumnMajor
