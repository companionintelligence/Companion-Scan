/**
 * The no-georeference golden: what the server places today, held bit for bit.
 *
 * The georeference work (docs/adr/0015-scene-convention-and-georeference.md) moves how a scan is carried onto the map.
 * It must not move a scan that has no georeference: a Place nobody has registered keeps every placement it has, and a
 * world file the previous build wrote keeps loading with the matrices it holds. This test is that promise, written
 * BEFORE the change from what the previous build did, and kept as the guard.
 *
 * `fixtures/world-placement-golden.json` was captured from the server before any of the georeference code existed, with
 * the scans of `world_placement_fixtures.ts` (a calibrated two-point scan, a one-point one, scans with a fix of every
 * quality, one with no bearing, one with no altitude, one 300 m away, one with no fix at all). It holds
 *
 *  - `legacyWorldFile`: the world file the previous build wrote for the first eight scans (it declares `z: 'north'`);
 *  - `afterFirstRead`: the placement of each of those scans (`localToWorld`, `geoDistanceM`, `geoOutlier`,
 *    `calibratedLocalToWorld`) when the server read them;
 *  - `afterLaterScans`: the same after three more scans arrived and the world was read again.
 *
 * What is pinned, through the real server:
 *
 *  1. A world file the previous build wrote loads, and every scan in it keeps its matrix (the freeze that keeps a
 *     person's manual moves), however its sidecar changes later.
 *  2. A scan that arrives in such a world is placed exactly as the previous build placed it: from its own fix, by the
 *     sphere `geoToEnu`, with the raw device heading as the yaw. A world that says `z: 'north'` keeps being placed the
 *     way it was, however many scans are added to it, so its scans stay consistent with each other.
 *  3. A calibrated scan in a world with no georeference sits at its `projectTransform` as it is, in a world of either
 *     convention: that is the placement the Place frame defines, and a georeference is the only thing that moves it.
 *
 * What is NOT pinned here, on purpose: the uncalibrated scans of a world the new code writes. A new world declares the
 * right-handed scene and places them with the gates and the scene yaw of ADR 0015: world_origin.test.ts and
 * georef_world.test.ts pin that, and say how it differs.
 */
import { assertEquals } from './assert.ts'
import { readWorld, startServer, writeScan } from './georef_server_support.ts'
import { FIRST_SCANS, LATER_SCANS } from './world_placement_fixtures.ts'
import type { WorldProject } from '../../../src/world/types.ts'
import * as fs from 'node:fs/promises'
import { test } from 'node:test'

interface PlacementRecord {
  localToWorld: number[]
  geoDistanceM: number | null
  geoOutlier: boolean
  calibratedLocalToWorld: number[] | null
}

interface Golden {
  legacyWorldFile: WorldProject
  afterFirstRead: Record<string, PlacementRecord>
  afterLaterScans: Record<string, PlacementRecord>
  orderAfterLaterScans: string[]
}

const GOLDEN = JSON.parse(await fs.readFile(new URL('./fixtures/world-placement-golden.json', import.meta.url), 'utf8')) as Golden

function placementsOf(world: WorldProject): Record<string, PlacementRecord> {
  return Object.fromEntries(world.scans.map((scan) => [scan.name, {
    localToWorld: scan.localToWorld,
    geoDistanceM: scan.geoDistanceM,
    geoOutlier: scan.geoOutlier ?? false,
    calibratedLocalToWorld: scan.calibratedLocalToWorld ?? null,
  }]))
}

const NAMES = FIRST_SCANS.map((scan) => scan.name)

test('golden: a world file the previous build wrote keeps every placement it holds, and a scan added to it is placed as it always was', async () => {
    const server = await startServer({}, {
      worlds: { default: JSON.stringify(GOLDEN.legacyWorldFile) },
      scans: async (dir) => {
        for (const scan of FIRST_SCANS) await writeScan(dir, scan.name, scan.meta, scan.mtimeMs)
      },
    })
    try {
      assertEquals(GOLDEN.legacyWorldFile.localFrame.axes.z, 'north', 'the fixture is a legacy world')

      // 1. The file loads, and the scans in it are where the file put them.
      const first = await readWorld(server)
      assertEquals(placementsOf(first), GOLDEN.afterFirstRead, 'every placement in the world file the previous build wrote')
      assertEquals(first.localFrame.axes.z, 'north', 'and the world still says what it said')

      // 2. Three scans arrive. They are placed from their own fixes, by the legacy rule, against the origin the world latched.
      for (const scan of LATER_SCANS) await writeScan(server.scansDir, scan.name, scan.meta, scan.mtimeMs)
      const later = await readWorld(server)
      assertEquals(later.scans.map((scan) => scan.name), GOLDEN.orderAfterLaterScans)
      assertEquals(placementsOf(later), GOLDEN.afterLaterScans, 'the added scans are placed as the previous build placed them, and the first eight have not moved')

      // 3. A sidecar that changes later does not move a scan that is already in the world (a person's moves depend on it).
      const changed = FIRST_SCANS.find((scan) => scan.name === 'gps-nullalt')!
      await writeScan(server.scansDir, changed.name, { ...changed.meta, geoLat: 51.51, geoLng: -0.13, geoBearing: 300 }, changed.mtimeMs)
      const unchanged = await readWorld(server)
      // The row follows the sidecar in everything but where the scan stands: its distance from the origin is the sidecar's.
      const moved = unchanged.scans.find((scan) => scan.name === 'gps-nullalt')!
      assertEquals(moved.geoDistanceM === GOLDEN.afterLaterScans['gps-nullalt']!.geoDistanceM, false, 'the new fix was read')
      for (const scan of unchanged.scans) {
        const was = GOLDEN.afterLaterScans[scan.name]!
        assertEquals(scan.localToWorld, was.localToWorld, `${scan.name}: a changed sidecar moves nothing`)
        assertEquals(scan.calibratedLocalToWorld ?? null, was.calibratedLocalToWorld, `${scan.name}: and does not change its first placement`)
      }
    } finally {
      await server.stop()
    }
  })

test('golden: a calibrated scan in a world with no georeference sits at its projectTransform as it is', async () => {
    // No world file: the server writes this world itself, so this is the placement the current build gives a scan of a new world.
    const server = await startServer({}, {
      scans: async (dir) => {
        for (const scan of FIRST_SCANS) await writeScan(dir, scan.name, scan.meta, scan.mtimeMs)
      },
    })
    try {
      const world = await readWorld(server)
      const placed = placementsOf(world)
      for (const name of ['cal-two', 'cal-one']) {
        assertEquals(placed[name]!.localToWorld, GOLDEN.afterFirstRead[name]!.localToWorld, `${name}: the matrix the sidecar's projectTransform is`)
        assertEquals(placed[name]!.calibratedLocalToWorld, GOLDEN.afterFirstRead[name]!.calibratedLocalToWorld, `${name}: and its first placement`)
      }
      assertEquals(Object.keys(placed).sort(), [...NAMES].sort())
    } finally {
      await server.stop()
    }
  })
