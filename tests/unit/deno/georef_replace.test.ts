/**
 * What happens to a world's placements when a person's work, a Place's frame or the registry meets a new georeference, through the
 * real server (the same code as wired into `refreshWorldScans`, `removeAllScansFromWorlds` and the jobs, reading sidecars from disk and
 * a registry from a file). The pure decisions are world_origin.test.ts's; georef_world.test.ts is the main flow. This file holds what the
 * review of the first build found, each as the scenario that found it:
 *
 *  1. A scan whose only move was undone is placed by the next georeference, and the patch log, which the editor replays, ends where the
 *     server put it (it ended at the undo record's older placement). A reset to calibrated follows the georeference too, and its log
 *     agrees. A registration confirmed with every number as it was flags nothing; a real change still does.
 *  2. A scan a person placed says so in the scan list, and makes no claim about the map.
 *  3. A Place whose frame was replaced under its georeference (both frame ids known) is no longer georeferenced in its world, and a scan
 *     of the new frame is not carried by the old registration; a save against the new frame places the world again.
 *  4. Things follow the scans that were placed again.
 *  5. A registry that cannot be read adds no scan to a world, and a scan arriving then is added, placed, on the next read that can.
 *  6. Deleting every scan does not take a georeferenced world's origin away.
 *  7. A mixed Place keeps the scans not in its frame out of Thing matching; a Place with none in its frame matches all of them.
 *  8. Each scan of the whole-Place glTF says how it was placed.
 */
import { assert, assertAlmostEquals, assertEquals, assertNotEquals } from 'jsr:@std/assert@^1.0.0'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { enuToGeodetic } from '../../../src/world/enu.ts'
import { transformPoint } from '../../../src/world/geo.ts'
import { buildGeoreference, georeferenceFrameState } from '../../../src/world/georef.ts'
import type { GeoSession } from '../../../src/world/geo-session.ts'
import { liveScanPlacementPatches } from '../../../src/world/scan-placement.ts'
import { isHandPlaced, replayedScanPlacement } from '../../../src/world/scan-hand-placement.ts'
import { worldReadout } from '../../../src/viewer/georef-hud.ts'
import { placementNote } from '../../../src/viewer/placement-note.ts'
import type { Project, ProjectGeoreference, ScanManifest, WorldProject } from '../../../src/world/types.ts'
import { placeCalibratedScan } from '../../../server/world/world_origin.ts'
import { type RunningServer, readWorld, startServer, writeScan } from './georef_server_support.ts'
import { PROJECT_TRANSFORM, sidecarOf } from './world_placement_fixtures.ts'

const LONDON = { lat: 51.5007, lng: -0.1246 }
const START = '2026-11-01T10:00:00.000Z'
const STARTED_MS = Date.parse(START)
const T0 = Date.parse(START)
const at = (minutes: number) => T0 + minutes * 60_000
const WORLD = '/projects/proj-1/world'

const frame = (frameId?: string, createdAt = '2026-10-31T09:00:00.000Z') => ({
  version: 1,
  createdAt,
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: 2 },
  separationM: 2,
  toleranceM: 0.15,
  anchorBearingDeg: null,
  ...(frameId ? { frameId } : {}),
})

const place = (projectId: string, frameId?: string): Record<string, unknown> => ({
  projectId,
  name: projectId === 'proj-1' ? 'Kitchen' : 'Garage',
  placeType: 'room',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
  areas: [{ areaId: `area-${projectId}`, name: 'Site', kind: 'site', parentAreaId: null }],
  floors: [{ floorId: 'floor-1', name: 'Ground Floor', level: 0, rooms: [{ roomId: 'room-1', name: 'Room' }] }],
  spatialFrame: frame(frameId),
  spatialFrameRevision: 1,
})
const PLACE = place('proj-1')

const georef = (bearingDeg: number, extra: Partial<ProjectGeoreference> = {}): ProjectGeoreference => ({
  ...buildGeoreference({ ...LONDON, originAccuracyM: 3.5, bearingDeg, bearingAccuracyDeg: 1, source: 'map-click', anchorRef: null, now: new Date('2026-11-17T10:00:00Z'), confirmed: true }),
  ...extra,
})

function geoSession(bearingDeg: number): GeoSession {
  return {
    v: 1,
    startedAt: START,
    fix: { offsetS: 8, sessionX: null, sessionZ: null },
    bearing: { deg: bearingDeg, spreadDeg: 4, sigmaDeg: 15, samples: 30, spanS: 9, source: 'android-absolute' },
    declination: { deg: 1.2, model: 'WMM2025', year: 2026.84 },
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

/** A sidecar of `projectId`, with a fix `east` and `north` metres from LONDON in the first seconds of the walk, and detections (session coordinates). */
function sidecar(
  name: string,
  options: { projectId?: string; east?: number; north?: number; session?: GeoSession | null; calibration?: Record<string, unknown> | null; frameId?: string; detections?: Array<{ x: number; y: number; z: number }> } = {},
): Record<string, unknown> {
  const { projectId = 'proj-1', east = 5, north = 5, session = null, calibration = null, frameId, detections = [] } = options
  const where = enuToGeodetic({ ...LONDON, altitudeM: 0 }, { east, north, up: 0 })
  return {
    ...sidecarOf(name, { lat: where.lat, lng: where.lng, accuracy: 6, altitudeM: 12.5, bearing: 321, fixedAt: new Date(STARTED_MS + 8000).toISOString() }, calibration),
    projectId,
    ...(session ? { geoSession: session } : {}),
    ...(frameId ? { calibrationFrameId: frameId } : {}),
    detections: detections.map((worldPos) => ({ label: 'chair', confidence: 0.9, worldPos })),
    detectionCount: detections.length,
  }
}

const byName = (world: WorldProject, name: string): ScanManifest => {
  const scan = world.scans.find((candidate) => candidate.name === name)
  assert(scan, `no scan named ${name}: ${world.scans.map((s) => s.name).join(', ')}`)
  return scan
}

async function ownerOf(server: RunningServer, world: WorldProject): Promise<{ token: string }> {
  const file = await server.worldFile(world.shareSlug)
  return { token: file.members.find((m) => m.role === 'owner')!.token }
}

async function putGeoreference(server: RunningServer, record: ProjectGeoreference, expectedVersion: number, projectId = 'proj-1'): Promise<number> {
  const reply = await server.send('PUT', `/projects/${projectId}/georeference`, { georeference: record, expectedVersion })
  assertEquals(reply.status, 200, reply.text)
  return (reply.json as { georefVersion: number }).georefVersion
}

/** The editor's save of a move: an absolute matrix as a scan patch. */
async function saveMove(server: RunningServer, world: WorldProject, scan: ScanManifest, matrix: number[]): Promise<void> {
  const reply = await server.send('POST', `/worlds/${world.shareSlug}/patches`, { scope: 'scan', scanId: scan.scanId, targetId: scan.filename, transform: { matrix } }, await ownerOf(server, world))
  assertEquals(reply.status, 200, reply.text)
}

const nudged = (matrix: number[], dx: number) => matrix.map((n, i) => (i === 12 ? n + dx : n))
const reg = { sanitizeResources: false, sanitizeOps: false }

// ── 1. The patch log and the editor ──────────────────────────────────────────

Deno.test({
  name: 'an undone move, a reset to calibrated and a registration confirmed as it was: the world and the log the editor replays agree, and only a real change flags a scan',
  ...reg,
  fn: async () => {
    const server = await startServer({}, {
      seed: [PLACE],
      scans: async (dir) => {
        await writeScan(dir, 'cal-undo', sidecar('cal-undo', { calibration: TWO_POINT }), at(1))
        await writeScan(dir, 'cal-reset', sidecar('cal-reset', { calibration: TWO_POINT }), at(2))
        await writeScan(dir, 'cal-hand', sidecar('cal-hand', { calibration: TWO_POINT }), at(3))
      },
    })
    try {
      // Version 1, unconfirmed (typed numbers saved as approximate).
      const v1 = buildGeoreference({ ...LONDON, originAccuracyM: 3.5, bearingDeg: 75, bearingAccuracyDeg: 1, source: 'typed', anchorRef: null, now: new Date('2026-11-17T10:00:00Z'), confirmed: false })
      assertEquals(await putGeoreference(server, v1, 0), 1)
      let world = await readWorld(server, WORLD)
      const first = byName(world, 'cal-undo').localToWorld
      assertEquals(first, placeCalibratedScan(v1, LONDON, PROJECT_TRANSFORM))

      // cal-undo: moved and taken back. cal-reset: moved and reset to calibrated (an ordinary patch). cal-hand: moved, and left.
      const undo = byName(world, 'cal-undo')
      await saveMove(server, world, undo, nudged(first, 1.5))
      world = await readWorld(server, WORLD)
      const moveId = world.editPatches.at(-1)!.patchId
      const reverted = await server.send('POST', `/worlds/${world.shareSlug}/patches/revert`, { scanId: undo.scanId, patchId: moveId }, await ownerOf(server, world))
      assertEquals(reverted.status, 200, reverted.text)
      const reset = byName(world, 'cal-reset')
      await saveMove(server, world, reset, nudged(first, 2))
      await saveMove(server, world, reset, [...reset.calibratedLocalToWorld!])
      const hand = byName(world, 'cal-hand')
      await saveMove(server, world, hand, nudged(first, 0.05))

      // The same numbers, confirmed: version 2, and nothing changed for any scan.
      const v2 = buildGeoreference({ ...LONDON, originAccuracyM: 3.5, bearingDeg: 75, bearingAccuracyDeg: 1, source: 'typed', anchorRef: null, now: new Date('2026-11-17T11:00:00Z'), confirmed: true })
      assertEquals(await putGeoreference(server, v2, 1), 2)
      world = await readWorld(server, WORLD)
      assertEquals(world.georefVersion, 2)
      for (const name of ['cal-undo', 'cal-reset', 'cal-hand']) assertEquals(byName(world, name).placementStale, undefined, `${name}: confirming nothing new is no news`)
      assertEquals(byName(world, 'cal-hand').localToWorld, nudged(first, 0.05), 'the person\'s move stands')

      // A real change: the bearing turns to 200.
      const v3 = buildGeoreference({ ...LONDON, originAccuracyM: 3.5, bearingDeg: 200, bearingAccuracyDeg: 1, source: 'typed', anchorRef: null, now: new Date('2026-11-17T12:00:00Z'), confirmed: true })
      assertEquals(await putGeoreference(server, v3, 2), 3)
      world = await readWorld(server, WORLD)
      const target = placeCalibratedScan(v3, LONDON, PROJECT_TRANSFORM)
      for (const name of ['cal-undo', 'cal-reset']) {
        const scan = byName(world, name)
        assertEquals(scan.localToWorld, target, `${name} is at its calibration, so it follows`)
        assertEquals(scan.placementStale, undefined, name)
        assertEquals(scan.placementSource, 'georeference', name)
        assertEquals(liveScanPlacementPatches(world.editPatches, scan), [], `${name}: no move holds it`)
        // The editor replays the log over the world's matrix: where it draws the scan is where the world says it is.
        assertEquals(replayedScanPlacement(world.editPatches, scan), scan.localToWorld, `${name}: the editor and the server agree`)
        assertEquals(isHandPlaced(world.editPatches, scan), false, name)
        assertEquals(placementNote(scan, { placedByHand: isHandPlaced(world.editPatches, scan) })!.text, `On the map, approximate to about ${Number(scan.placementUncertaintyM!.toPrecision(2))} m`)
      }
      // The scan a person placed does not move, is flagged, and says it was placed by hand.
      const stuck = byName(world, 'cal-hand')
      assertEquals(stuck.localToWorld, nudged(first, 0.05))
      assertEquals(stuck.placementStale, true)
      assertEquals(stuck.calibratedLocalToWorld, target)
      assertEquals(replayedScanPlacement(world.editPatches, stuck), stuck.localToWorld)
      assertEquals(isHandPlaced(world.editPatches, stuck), true)
      const note = placementNote(stuck, { placedByHand: true })!
      assertEquals(note.text, 'Placed by hand')
      assertEquals(note.staleLine, 'Moved before the location was set')

      // A read again is the same, and the log does not grow.
      const patches = world.editPatches.length
      world = await readWorld(server, WORLD)
      assertEquals(world.editPatches.length, patches)
    } finally {
      await server.stop()
    }
  },
})

// ── 3. A Place whose frame was replaced under its georeference ───────────────

Deno.test({
  name: 'a Place whose frame is replaced is no longer georeferenced in its world, a scan of the new frame is not carried by the old registration, and saving against the new frame places the world again',
  ...reg,
  fn: async () => {
    const server = await startServer({}, {
      seed: [place('proj-1', 'frame-a')],
      scans: async (dir) => {
        await writeScan(dir, 'cal-old', sidecar('cal-old', { calibration: TWO_POINT, frameId: 'frame-a' }), at(1))
      },
    })
    try {
      const v1 = georef(75, { anchorRef: 'frame-a' })
      assertEquals(await putGeoreference(server, v1, 0), 1)
      let world = await readWorld(server, WORLD)
      assertEquals(byName(world, 'cal-old').placementSource, 'georeference')
      assertEquals(worldReadout(world, { x: 0, y: 0, z: 0 }).geographic, true)

      // The Place's alignment is made again: a new generation.
      // A new generation says which it replaces and why (ADR 0011): here the person made the alignment again over the old one.
      const replaced = await server.send('PUT', '/projects/proj-1/spatial-frame', { frame: frame('frame-b', '2026-11-16T09:00:00.000Z'), expectedRevision: 1, replaces: { frameId: 'frame-a', reason: 'override' } })
      assertEquals(replaced.status, 200, replaced.text)
      await writeScan(server.scansDir, 'cal-new', sidecar('cal-new', { calibration: TWO_POINT, frameId: 'frame-b' }), at(2))
      world = await readWorld(server, WORLD)

      // The registration is of the earlier alignment: the world forgets it, says nothing on the map, and says so no more for the scans it placed.
      assertEquals(world.georeference, undefined)
      assertEquals(world.georefVersion, undefined)
      assertEquals(worldReadout(world, { x: 0, y: 0, z: 0 }).geographic, false, 'the readout is local: it will not print a latitude it has no registration for')
      assertEquals(byName(world, 'cal-old').placementSource, undefined, 'nothing registers it now')
      assertEquals(byName(world, 'cal-old').placementStale, undefined)
      // The scan of the new frame sits at its calibration in the Place, and the old registration does not carry it.
      assertEquals(byName(world, 'cal-new').placementSource, 'place-frame')
      assertEquals(byName(world, 'cal-new').localToWorld, PROJECT_TRANSFORM.map((n) => n + 0))
      // The Place still holds the record, so the panel can say it is of an earlier alignment and offer the save again.
      const held = (await server.send('GET', '/projects/proj-1')).json as Project
      assertEquals(held.georeference?.anchorRef, 'frame-a')
      assertEquals(georeferenceFrameState(held.georeference, held.spatialFrame as { frameId?: string }), 'other-frame')

      // The location saved again against the new alignment: the new scan is carried, and the old one is not in this frame.
      const stale = await server.send('PUT', '/projects/proj-1/georeference', { georeference: georef(75, { anchorRef: 'frame-a', registeredAt: '2026-11-17T12:00:00.000Z' }), expectedVersion: 1 })
      assertEquals(stale.status, 400, 'a record for the earlier alignment is refused')
      const v2 = georef(120, { anchorRef: 'frame-b', registeredAt: '2026-11-17T12:00:00.000Z' })
      assertEquals(await putGeoreference(server, v2, 1), 2)
      world = await readWorld(server, WORLD)
      assertEquals(world.georefVersion, 2)
      assertEquals(byName(world, 'cal-new').placementSource, 'georeference')
      assertEquals(byName(world, 'cal-new').localToWorld, placeCalibratedScan(v2, LONDON, PROJECT_TRANSFORM))
      assertEquals(byName(world, 'cal-old').placementSource, undefined, 'a scan of the earlier alignment is not carried by this one')
      assertEquals(byName(world, 'cal-old').localToWorld, PROJECT_TRANSFORM.map((n) => n + 0), 'it sits as it was calibrated')
    } finally {
      await server.stop()
    }
  },
})

// ── 4. Things follow their scans ─────────────────────────────────────────────

async function runJob(server: RunningServer, slug: string, type: string, payload?: Record<string, unknown>): Promise<void> {
  const world = await readWorld(server, `/worlds/${slug}`)
  const queued = await server.send('POST', `/worlds/${slug}/jobs`, { type, ...(payload ? { payload } : {}) }, await ownerOf(server, world))
  assertEquals(queued.status, 202, queued.text)
  const jobId = (queued.json as { jobId: string }).jobId
  let status = ''
  for (let i = 0; i < 150 && status !== 'completed' && status !== 'failed'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    status = (await readWorld(server, `/worlds/${slug}`)).jobs.find((job) => job.jobId === jobId)?.status ?? ''
  }
  assertEquals(status, 'completed', `the ${type} job ended ${status}\n${server.log()}`)
}

Deno.test({
  name: 'Things and their observations follow the scans a georeference places again, so a Thing is where the scan\'s detection is, and a Thing of a scan a person placed stays with it',
  ...reg,
  fn: async () => {
    const server = await startServer({}, {
      seed: [PLACE],
      scans: async (dir) => {
        await writeScan(dir, 'cal-a', sidecar('cal-a', { calibration: TWO_POINT, detections: [{ x: 0.4, y: 0.9, z: 2 }] }), at(1))
        await writeScan(dir, 'cal-b', sidecar('cal-b', { calibration: TWO_POINT, detections: [{ x: -3, y: 0.5, z: 5 }] }), at(2))
      },
    })
    try {
      assertEquals(await putGeoreference(server, georef(75), 0), 1)
      let world = await readWorld(server, WORLD)
      const b = byName(world, 'cal-b')
      await runJob(server, world.shareSlug, 'thing-correspondence')
      world = await readWorld(server, WORLD)
      assertEquals(world.things.length, 2)
      const local = { a: { x: 0.4, y: 0.9, z: 2 }, b: { x: -3, y: 0.5, z: 5 } }
      const thingOf = (scanName: string) => world.things.find((thing) => thing.firstSeenScanId === byName(world, scanName).scanId)!
      const dist = (p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number }) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)
      assert(dist(thingOf('cal-a').position, transformPoint(byName(world, 'cal-a').localToWorld, local.a)) < 1e-9, 'the correspondence job put the Thing where the scan\'s detection is')

      // A person places cal-b; then the bearing turns: cal-a moves metres, cal-b does not.
      await saveMove(server, world, b, nudged(b.localToWorld, 0.5))
      const stays = (await readWorld(server, WORLD)).things.find((thing) => thing.firstSeenScanId === b.scanId)!.position
      assertEquals(await putGeoreference(server, georef(200, { registeredAt: '2026-11-17T12:00:00.000Z' }), 1), 2)
      world = await readWorld(server, WORLD)
      const a2 = byName(world, 'cal-a')
      const want = transformPoint(a2.localToWorld, local.a)
      assert(dist(thingOf('cal-a').position, want) < 1e-9, `the Thing is ${JSON.stringify(thingOf('cal-a').position)} and the detection is ${JSON.stringify(want)}`)
      const observation = world.thingObservations.find((o) => o.scanId === a2.scanId)!
      assert(dist(observation.worldPos, want) < 1e-9, 'and so is its observation')
      assertEquals(thingOf('cal-b').position, stays, 'the scan a person placed did not move, so what it saw did not')
      assertNotEquals(thingOf('cal-a').position, transformPoint(byName(await readWorld(server, WORLD), 'cal-a').calibratedLocalToWorld!, { x: 99, y: 0, z: 0 }))
    } finally {
      await server.stop()
    }
  },
})

// ── 5. A registry that cannot be read ────────────────────────────────────────

Deno.test({
  name: 'while the registry cannot be read no scan is added to a world, and the scan that arrived is added and placed through the georeference on the next read that can',
  ...reg,
  fn: async () => {
    const seeded = { ...PLACE, georeference: georef(75), georefVersion: 1 }
    const server = await startServer({}, {
      seed: [seeded],
      scans: async (dir) => {
        await writeScan(dir, 'cal-a', sidecar('cal-a', { calibration: TWO_POINT }), at(1))
      },
    })
    try {
      let world = await readWorld(server, WORLD)
      assertEquals(world.scans.length, 1)
      assertEquals(world.georefVersion, 1)
      const good = await Deno.readTextFile(server.registryFile)

      // The registry cannot be read this moment, and a calibrated scan of a one-point kind arrives: nothing can say which frame it is in.
      await Deno.writeTextFile(server.registryFile, '{ not json')
      await writeScan(server.scansDir, 'one-point', sidecar('one-point', { calibration: { ...TWO_POINT, method: 'ground-tap-compass', status: 'provisional' } }), at(2))
      const during = await server.send('GET', '/worlds/project-proj-1')
      assertEquals(during.status, 200, 'the world is still read')
      world = during.json as WorldProject
      assertEquals(world.scans.map((scan) => scan.name), ['cal-a'], 'and no scan is added without the Place to place it by')
      assertEquals(world.georefVersion, 1, 'nor does it forget what it holds')

      // The registry is back: the scan is added, once, in its own frame (a one-point scan of a two-point Place), and nothing else moved.
      await Deno.writeTextFile(server.registryFile, good)
      world = await readWorld(server, '/worlds/project-proj-1')
      assertEquals(world.scans.map((scan) => scan.name).sort(), ['cal-a', 'one-point'])
      const onePoint = byName(world, 'one-point')
      assertEquals(onePoint.localToWorld, PROJECT_TRANSFORM.map((n) => n + 0), 'a one-point scan is not carried by a two-point Place\'s georeference')
      assertEquals(onePoint.placementSource, undefined)
    } finally {
      await server.stop()
    }
  },
})

// ── 6. Deleting every scan ───────────────────────────────────────────────────

Deno.test({
  name: 'deleting every scan leaves a georeferenced world its origin, and a world with none loses it as it always did',
  ...reg,
  fn: async () => {
    const server = await startServer({}, {
      seed: [PLACE, place('proj-2')],
      scans: async (dir) => {
        await writeScan(dir, 'cal-a', sidecar('cal-a', { calibration: TWO_POINT }), at(1))
        await writeScan(dir, 'gps-g', sidecar('gps-g', { projectId: 'proj-2', session: geoSession(90) }), at(2))
      },
    })
    try {
      assertEquals(await putGeoreference(server, georef(75), 0), 1)
      const georeferenced = await readWorld(server, WORLD)
      const plain = await readWorld(server, '/projects/proj-2/world')
      assertEquals(georeferenced.originGeoPose.lat, LONDON.lat)
      assert(plain.originGeoPose.lat !== null, 'the other Place\'s world has the origin of its scan')

      const deleted = await server.send('DELETE', '/scans?confirm=delete-all')
      assertEquals(deleted.status, 200, deleted.text)
      const after = await readWorld(server, WORLD)
      assertEquals(after.scans.length, 0)
      assertEquals(after.originGeoPose.lat, LONDON.lat, 'the origin is the Place\'s georeference, which no deletion touches')
      assertEquals(after.localFrame.origin.lat, LONDON.lat)
      assertEquals(after.georeference?.origin.lat, LONDON.lat)
      assertEquals(worldReadout(after, { x: 0, y: 0, z: 0 }).geographic, true)
      const other = await readWorld(server, '/projects/proj-2/world')
      assertEquals(other.originGeoPose.lat, null, 'a world with no georeference loses its origin with its scans')
      assertEquals(other.localFrame.origin.lat, null)
      // A scan that arrives is placed against the origin that stayed.
      await writeScan(server.scansDir, 'cal-b', sidecar('cal-b', { calibration: TWO_POINT }), at(5))
      const next = await readWorld(server, WORLD)
      assertEquals(byName(next, 'cal-b').placementSource, 'georeference')
      assertEquals(byName(next, 'cal-b').localToWorld, placeCalibratedScan(georef(75), LONDON, PROJECT_TRANSFORM))
    } finally {
      await server.stop()
    }
  },
})

// ── 7. Thing matching in a mixed Place ───────────────────────────────────────

Deno.test({
  name: 'Thing matching takes the scans in the Place frame and no other (D6, scanTakesPartInThingMatching): not a GPS or grid scan, not one a person placed, and none in a Place with no scan in its frame',
  ...reg,
  fn: async () => {
    const chair = [{ x: 0, y: 0, z: 1 }]
    const server = await startServer({}, {
      seed: [PLACE, place('proj-2')],
      scans: async (dir) => {
        await writeScan(dir, 'cal-a', sidecar('cal-a', { calibration: TWO_POINT, detections: chair }), at(1))
        await writeScan(dir, 'gps-g', sidecar('gps-g', { session: geoSession(90), detections: chair }), at(2))
        await writeScan(dir, 'grid-n', sidecar('grid-n', { detections: chair }), at(3))
        await writeScan(dir, 'gps-1', sidecar('gps-1', { projectId: 'proj-2', session: geoSession(90), east: 20, detections: chair }), at(4))
        await writeScan(dir, 'gps-2', sidecar('gps-2', { projectId: 'proj-2', session: geoSession(90), east: 40, detections: chair }), at(5))
      },
    })
    try {
      const mixed = await readWorld(server, WORLD)
      assertEquals(mixed.scans.map((scan) => [scan.name, scan.placementSource]).sort(), [['cal-a', 'place-frame'], ['gps-g', 'gps-compass'], ['grid-n', 'grid']].sort())
      await runJob(server, mixed.shareSlug, 'thing-correspondence')
      const matched = await readWorld(server, WORLD)
      assertEquals(matched.thingObservations.map((observation) => observation.scanId), [byName(matched, 'cal-a').scanId], 'only the scan in the frame took part')
      assertEquals(matched.things.length, 1)

      // A person places the GPS scan: it is where they put it, and it is still not measured in the Place frame, so it stays out
      // until it is calibrated. (The editor's mixed-Place flag stops counting it; the matching does not change its rule.)
      const gps = byName(matched, 'gps-g')
      await saveMove(server, matched, gps, nudged(gps.localToWorld, 1))
      await runJob(server, matched.shareSlug, 'thing-correspondence')
      const placedByHand = await readWorld(server, WORLD)
      assertEquals(placedByHand.thingObservations.map((observation) => observation.scanId), [byName(placedByHand, 'cal-a').scanId])

      // A Place with no scan in its frame: no scan's positions are in a frame the Things' are in, so none takes part.
      const plain = await readWorld(server, '/projects/proj-2/world')
      assertEquals(plain.scans.map((scan) => scan.placementSource), ['gps-compass', 'gps-compass'])
      await runJob(server, plain.shareSlug, 'thing-correspondence')
      assertEquals((await readWorld(server, '/projects/proj-2/world')).thingObservations.length, 0)
    } finally {
      await server.stop()
    }
  },
})

// ── 8. The whole-Place glTF ──────────────────────────────────────────────────

Deno.test({
  name: 'each scan of the whole-Place glTF says how it was placed, so a reader can tell a scan the georeference carries from a GPS placement, a grid slot or a person\'s move',
  ...reg,
  fn: async () => {
    const server = await startServer({}, {
      seed: [PLACE],
      scans: async (dir) => {
        await writeScan(dir, 'cal-a', sidecar('cal-a', { calibration: TWO_POINT }), at(1))
        await writeScan(dir, 'gps-c', sidecar('gps-c', { session: geoSession(90), east: 12, north: -3 }), at(2))
        await writeScan(dir, 'old-grid', sidecar('old-grid', { east: -9, north: 4 }), at(3))
        await writeScan(dir, 'gps-moved', sidecar('gps-moved', { session: geoSession(90), east: 3, north: 3 }), at(4))
        await writeScan(dir, 'cal-moved', sidecar('cal-moved', { calibration: TWO_POINT }), at(5))
      },
    })
    try {
      assertEquals(await putGeoreference(server, georef(75), 0), 1)
      let world = await readWorld(server, WORLD)
      const moved = byName(world, 'gps-moved')
      await saveMove(server, world, moved, nudged(moved.localToWorld, 20))
      // A calibrated scan a person moved, and then the location turned: it did not move, and its position on the map is from before.
      const calMoved = byName(world, 'cal-moved')
      await saveMove(server, world, calMoved, nudged(calMoved.localToWorld, 3))
      assertEquals(await putGeoreference(server, georef(120, { registeredAt: '2026-11-17T12:00:00.000Z' }), 1), 2)
      world = await readWorld(server, WORLD)
      await runJob(server, world.shareSlug, 'export-world')
      const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).readBinary(await Deno.readFile(`${server.worldsDir}/${world.shareSlug}.world.glb`))
      const scene = doc.getRoot().listScenes()[0]!
      const extras = new Map(scene.listChildren().map((node) => [node.getName(), node.getExtras() as Record<string, unknown>]))
      assertEquals(extras.get('cal-a')!['placementSource'], 'georeference')
      assert(typeof extras.get('cal-a')!['placementUncertaintyM'] === 'number' && (extras.get('cal-a')!['placementUncertaintyM'] as number) >= 3.5)
      assertEquals(extras.get('gps-c')!['placementSource'], 'gps-compass')
      assertEquals(extras.get('old-grid')!['placementSource'], 'grid')
      assertEquals(extras.get('old-grid')!['placementUncertaintyM'], null, 'a grid slot is not a position: no uncertainty to state')
      assertEquals(extras.get('gps-moved')!['placedByHand'], true)
      assertEquals(extras.get('cal-moved')!['placedByHand'], true)
      assertEquals(extras.get('cal-moved')!['placementStale'], true, 'the location changed after the move: the node says its position on the map is from before')
      for (const name of ['cal-a', 'gps-c', 'old-grid']) assertEquals('placedByHand' in extras.get(name)!, false, `${name} was not moved`)
      for (const name of ['cal-a', 'gps-c', 'old-grid', 'gps-moved']) assertEquals('placementStale' in extras.get(name)!, false, `${name} is not stale`)
      // The existing keys are still there, and the scene still says what it is.
      assertEquals(Object.keys(extras.get('cal-a')!).includes('scanId'), true)
      assertEquals((scene.getExtras() as Record<string, unknown>)['frame'], 'place')
      assertAlmostEquals(((scene.getExtras() as Record<string, unknown>)['georeference'] as { bearingDeg: number }).bearingDeg, 120, 1e-12)
    } finally {
      await server.stop()
    }
  },
})
