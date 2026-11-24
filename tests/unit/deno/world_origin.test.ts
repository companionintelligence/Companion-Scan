/**
 * Where a scan goes in a Place's world (server/world/world_origin.ts), against a physical model that shares no code with it
 * (./physical_oracle.ts) and numbers this repository did not produce (./georef_reference.py, through georef_vectors.test.ts).
 *
 * What is pinned:
 *
 *  - the world's origin: the georeference's, else the best-ACCURACY located scan (not the newest), else none;
 *  - the calibrated placement `T(sceneFromEnu(geodeticToEnu(worldOrigin, origin))) x Ry(180 - bearing) x projectTransform`:
 *    its matrix convention against `composeYUpTransform` and `enu.ts`, the translation between two origins against the
 *    70-digit London pair, and, end to end, that two sessions with different start headings and origins put every feature
 *    where the oracle says to 1e-9 m, and a latitude and longitude read back from the scene is the surveyed one to 1 mm;
 *  - the uncalibrated placement and each of its gates (25 m, 60 s, 30 degrees, no bearing, no fix, the radius), the height
 *    that is never a GPS altitude, and the grid that has no yaw;
 *  - what a change of georeference version does to a world: unpatched scans are placed again, scans a person moved stay and
 *    are flagged, what "reset to calibrated" returns to follows, an unchanged version changes nothing;
 *  - the stamps: what the legacy path says, what is backfilled, what is never claimed.
 *
 * The same code through the real server is georef_world.test.ts; the no-georeference golden is world_placement_golden.test.ts.
 */
import { assert, assertAlmostEquals, assertEquals, assertNotEquals } from 'jsr:@std/assert@^1.0.0'
import { enuFromScene, enuToGeodetic, geodeticToEnu, sceneFromEnu, sceneYawForBearingDeg } from '../../../src/world/enu.ts'
import { composeYUpTransform, identityMatrix, transformPoint, twoPointToProjectTransform } from '../../../src/world/geo.ts'
import { ACCURACY_FLOORS, accuracyAt, buildGeoreference, georeferenceOriginAsGeoPose, seedOriginAccuracyM } from '../../../src/world/georef.ts'
import { invertAffine } from '../../../src/world/anchor-placement.ts'
import { buildRevertPatch, liveScanPlacementPatches, planRevert } from '../../../src/world/scan-placement.ts'
import { replayedScanPlacement } from '../../../src/world/scan-hand-placement.ts'
import type { GeoSession } from '../../../src/world/geo-session.ts'
import type { GeoPose, ProjectGeoreference, ScanManifest, Thing, ThingObservation, WorldProject, EditPatch, Project } from '../../../src/world/types.ts'
import {
  applyPlaceGeoreference,
  calibratedPlacement,
  createWorldPlacing,
  GEOREFERENCE_ACTOR,
  gridMatrix,
  inPlaceFrame,
  legacyPlacementStamps,
  multiplyColumnMajor,
  originIfMissing,
  placeCalibratedScan,
  placeFactsFor,
  placementContext,
  type PlacementHost,
  placementFields,
  placeSceneScan,
  placeStoredScan,
  type PlaceFacts,
  resolveWorldOrigin,
  sameMatrix,
  scanPlacementFacts,
  type ScanPlacementFacts,
  settleWorldPlacementStamps,
  withStoredPlacementStamps,
  worldConvention,
  type WorldPlacementContext,
  worldOriginOrNone,
} from '../../../server/world/world_origin.ts'
import {
  angDiff,
  applyColumnMajor,
  bearingOfEnu,
  enuToSession,
  type Enu,
  rotationDeterminant,
  trueSessionZBearing,
  type V3,
} from './physical_oracle.ts'

const LONDON = { lat: 51.5007, lng: -0.1246 }

const pose = (lat: number | null, lng: number | null, extra: Partial<GeoPose> = {}): GeoPose => ({
  lat,
  lng,
  altitudeM: null,
  bearing: null,
  accuracyM: null,
  ...extra,
})

const georef = (extra: Partial<ProjectGeoreference> = {}): ProjectGeoreference => ({
  origin: { ...LONDON, altitudeM: null, accuracyM: 3.5 },
  heightDatum: 'unknown',
  bearingDeg: 30,
  bearingAccuracyDeg: 1,
  convention: 2,
  datum: 'WGS84',
  source: 'map-click',
  registeredAt: '2026-11-17T10:00:00.000Z',
  confirmedAt: '2026-11-17T10:00:00.000Z',
  anchorRef: null,
  ...extra,
})

// ── The world's origin ───────────────────────────────────────────────────────

Deno.test('resolveWorldOrigin: the georeference first, then the best accuracy and not the newest, then nothing', () => {
  const scans = [
    { geoPose: pose(51.5, -0.12, { accuracyM: 30, address: 'newest' }) },
    { geoPose: pose(51.6, -0.13, { accuracyM: 4, address: 'best' }) },
    { geoPose: pose(51.7, -0.14, { accuracyM: 4, address: 'as good, older' }) },
    { geoPose: pose(51.8, -0.15, { accuracyM: null, address: 'no figure' }) },
  ]
  assertEquals(resolveWorldOrigin(null, scans)!.address, 'best', 'the most accurate, not the first')
  assertEquals(resolveWorldOrigin(undefined, scans)!.address, 'best')
  // A georeference wins over every scan, whatever their fixes.
  const origin = resolveWorldOrigin(georef({ origin: { lat: 48.85, lng: 2.35, altitudeM: 35, accuracyM: 5 }, heightDatum: 'ellipsoid' }), scans)!
  assertEquals([origin.lat, origin.lng, origin.altitudeM, origin.accuracyM, origin.bearing], [48.85, 2.35, 35, 5, null])
  // No figure ranks after any figure, equal figures keep the order given, and a scan that is not located is no candidate.
  assertEquals(resolveWorldOrigin(null, [{ geoPose: pose(51.8, -0.15) }, { geoPose: pose(51.9, -0.16, { accuracyM: 80 }) }])!.lat, 51.9)
  assertEquals(resolveWorldOrigin(null, [{ geoPose: pose(51.8, -0.15) }, { geoPose: pose(51.9, -0.16) }])!.lat, 51.8, 'no figure on either: the first')
  assertEquals(resolveWorldOrigin(null, [{ geoPose: pose(0, 0, { accuracyM: 1 }) }, { geoPose: pose(null, null, { accuracyM: 1 }) }, { geoPose: pose(51.5, -0.1, { accuracyM: 90 }) }])!.lat, 51.5, '(0, 0) is a missing fix')
  assertEquals(resolveWorldOrigin(null, []), null)
  assertEquals(resolveWorldOrigin(null, [{ geoPose: pose(null, null) }]), null)
  assertEquals(worldOriginOrNone(null), pose(null, null))
  assertEquals(worldOriginOrNone(pose(1, 2))!.lat, 1)
  // A negative accuracy is not a figure.
  assertEquals(resolveWorldOrigin(null, [{ geoPose: pose(51.1, 1, { accuracyM: -3 }) }, { geoPose: pose(51.2, 1, { accuracyM: 9 }) }])!.lat, 51.2)
})

// ── Matrices ─────────────────────────────────────────────────────────────────

/** A rotation about +Y and a translation, written out here rather than with the module's helper. */
function rotateYThenMove(yawDeg: number, t: V3): number[] {
  const c = Math.cos((yawDeg * Math.PI) / 180)
  const s = Math.sin((yawDeg * Math.PI) / 180)
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, t.x, t.y, t.z, 1].map((n) => n + 0)
}
const translation = (t: V3): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t.x, t.y, t.z, 1]

Deno.test('multiplyColumnMajor: a x b applies b first, the identity is neutral, and T x Ry is what composeYUpTransform builds', () => {
  const a = rotateYThenMove(37, { x: 1, y: 2, z: 3 })
  const b = rotateYThenMove(-110, { x: -4, y: 0.5, z: 9 })
  assertEquals(multiplyColumnMajor(identityMatrix(), a), a)
  assertEquals(multiplyColumnMajor(a, identityMatrix()), a)
  const p: V3 = { x: 0.3, y: -1.2, z: 2.5 }
  const viaProduct = applyColumnMajor(multiplyColumnMajor(a, b), p)
  const viaTwoSteps = applyColumnMajor(a, applyColumnMajor(b, p))
  assertAlmostEquals(viaProduct.x, viaTwoSteps.x, 1e-12)
  assertAlmostEquals(viaProduct.y, viaTwoSteps.y, 1e-12)
  assertAlmostEquals(viaProduct.z, viaTwoSteps.z, 1e-12)
  // The convention the module states: composeYUpTransform(t, yaw) = T(t) x Ry(yaw): the turn, then the move.
  const t: V3 = { x: 12, y: -3, z: 7 }
  const composed = composeYUpTransform(t, 123, 1)
  const product = multiplyColumnMajor(translation(t), rotateYThenMove(123, { x: 0, y: 0, z: 0 }))
  for (let i = 0; i < 16; i++) assertAlmostEquals(composed[i]!, product[i]!, 1e-15, `element ${i}`)
  // And it is not the other order: Ry(yaw) x T(t) would turn the translation too.
  const wrong = multiplyColumnMajor(rotateYThenMove(123, { x: 0, y: 0, z: 0 }), translation(t))
  assert(Math.hypot(wrong[12]! - composed[12]!, wrong[14]! - composed[14]!) > 1)
  assert(sameMatrix([...a], [...a]))
  assert(!sameMatrix(a, b) && !sameMatrix(a, null) && !sameMatrix(a, a.slice(0, 15)))
  assert(sameMatrix([-0, ...a.slice(1)], [0, ...a.slice(1)]), '-0 and 0 are the same number')
})

// ── placeCalibratedScan ──────────────────────────────────────────────────────

/**
 * [name, world origin, georeference origin, [east, north]] with BOTH heights 0, from georef_reference.py: the exact offset of
 * the second from the first on the ellipsoid at the Place floor. (The same pairs with their heights, in georef_vectors.test.ts,
 * differ by about 2e-6 of the offset per metre of height, which is why placement takes none: 7.8e-5 m for a 1 m step at 42 m.)
 */
const FLOOR_PAIRS: Array<[string, { lat: number; lng: number }, { lat: number; lng: number }, [number, number]]> = [
  ['singapore', { lat: 1.3521, lng: 103.8198 }, { lat: 1.3530, lng: 103.8210 }, [1.335463944800975e+2, 9.951743801141162e+1]],
  ['london', { lat: 51.5007, lng: -0.1246 }, { lat: 51.5010, lng: -0.1240 }, [4.166339816827527e+1, 3.337752568491205e+1]],
  ['sydney', { lat: -33.8568, lng: 151.2153 }, { lat: -33.8570, lng: 151.2150 }, [-2.776179181278566e+1, -2.218400127873256e+1]],
  ['tromso', { lat: 69.6492, lng: 18.9553 }, { lat: 69.6495, lng: 18.9560 }, [2.717898395181424e+1, 3.346742363004569e+1]],
  ['fiji_antimeridian', { lat: -16.5, lng: 179.9999 }, { lat: -16.5001, lng: -179.9999 }, [2.135282000398272e+1, -1.106640078973133e+1]],
  ['wellington', { lat: -41.2865, lng: 174.7762 }, { lat: -41.286, lng: 174.777 }, [6.701636219271909e+1, 5.552941376273019e+1]],
]

Deno.test('placeCalibratedScan: between two origins the translation is the exact east and north of one from the other (six 70-digit pairs), never a height, and the rotation is Ry(180 - bearing)', () => {
  for (const [name, worldOrigin, origin, [east, north]] of FLOOR_PAIRS) {
    // Bearing 180 is Ry(0): the rotation block is the identity, so the matrix is the translation, (E, 0, -N) in the scene.
    const m = placeCalibratedScan(georef({ origin: { ...origin, altitudeM: 12, accuracyM: 3.5 }, heightDatum: 'ellipsoid', bearingDeg: 180 }), worldOrigin, identityMatrix())
    assertAlmostEquals(m[12]!, east, 2e-6, `${name}: east`)
    assertEquals(m[13], 0, `${name}: the height is the Place floor, never an altitude`)
    assertAlmostEquals(m[14]!, -north, 2e-6, `${name}: z is south, so north is minus z`)
    for (const i of [0, 5, 10, 15]) assertEquals(m[i], 1)
    for (const i of [1, 2, 3, 4, 6, 7, 8, 9, 11]) assertEquals(m[i], 0)
  }
  // The offset is taken before the turn: Ry(yaw) turns the Place frame about its own origin, and the move is that origin's.
  const [, worldOrigin, origin, [east, north]] = FLOOR_PAIRS[1]!
  const turned = placeCalibratedScan(georef({ origin: { ...origin, altitudeM: null, accuracyM: 3.5 }, bearingDeg: 30 }), worldOrigin, identityMatrix())
  assertAlmostEquals(turned[12]!, east, 2e-6, 'the translation is the same whatever the bearing')
  assertAlmostEquals(turned[14]!, -north, 2e-6)
  const z = applyColumnMajor(turned, { x: 0, y: 0, z: 1 })
  assertAlmostEquals(z.x - turned[12]!, Math.sin(Math.PI / 6), 1e-12, 'and +Z lands on bearing 30')
  assertAlmostEquals(z.z - turned[14]!, -Math.cos(Math.PI / 6), 1e-12)
  // The same origin twice: the translation is exactly zero, and a -0 is written 0 (the world file and memory hold the same bits).
  const here = placeCalibratedScan(georef({ bearingDeg: 180 }), LONDON, identityMatrix())
  assertEquals([here[12], here[13], here[14]], [0, 0, 0])
  assert(here.every((n) => !Object.is(n, -0)), 'no -0 in a stored matrix')
  // The result has no height in it whatever the heights say.
  const high = placeCalibratedScan(georef({ origin: { ...LONDON, altitudeM: 900, accuracyM: 3.5 }, heightDatum: 'ellipsoid' }), { lat: 51.50071, lng: -0.1246 }, identityMatrix())
  assertEquals(high[13], 0)
})

/** Physical features of a room, in metres east, north and up of the landmark. */
const FEATURES: Enu[] = [
  { east: 3, north: 0, up: 0.5 },
  { east: 0, north: 4, up: 1 },
  { east: -2, north: -3, up: 0 },
  { east: 2, north: 2, up: 2 },
  { east: -3.7, north: 2.9, up: 0.35 },
]

Deno.test('two sessions with different start headings and origins put every feature where the oracle does, to 1e-9 m, and the surveyed latitude and longitude come back to 1 mm', () => {
  // The Place: the landmark at the physical origin of the Place frame, the marker 3.1 m away. Its true bearing is what a surveyed
  // map would give for the landmark-to-marker direction.
  const landmarkAt: Enu = { east: 0, north: 0, up: 0 }
  const markerAt: Enu = { east: 2.4, north: 1.9, up: 0 }
  const placeBearing = bearingOfEnu({ east: markerAt.east - landmarkAt.east, north: markerAt.north - landmarkAt.north })
  const record = georef({ bearingDeg: placeBearing, bearingAccuracyDeg: 1, source: 'survey', origin: { ...LONDON, altitudeM: null, accuracyM: 0.05 } })
  // Each session started at its own spot facing its own way; the Place frame is rebuilt from the same two physical points in each.
  const sessions: Array<{ psi: number; origin: Enu }> = [
    { psi: 10, origin: { east: -1.5, north: -2, up: 0 } },
    { psi: 137, origin: { east: 3.5, north: 1, up: 0 } },
    { psi: 290, origin: { east: -4, north: 6, up: 0 } },
    { psi: 0, origin: { east: 0.2, north: 0.1, up: 0 } },
    { psi: 180, origin: { east: 7, north: -3, up: 0 } },
    { psi: 359, origin: { east: -2, north: 2, up: 0 } },
  ]
  let worst = 0
  let worstMm = 0
  for (const s of sessions) {
    const rel = (p: Enu): V3 => enuToSession(s.psi, { east: p.east - s.origin.east, north: p.north - s.origin.north, up: p.up - s.origin.up })
    const landmark = rel(landmarkAt)
    const marker = { ...rel(markerAt), y: landmark.y }
    const projectTransform = twoPointToProjectTransform(landmark, marker)
    const placed = placeCalibratedScan(record, LONDON, projectTransform)
    assertAlmostEquals(rotationDeterminant(placed), 1, 1e-12, `session ${s.psi}: a rotation, not a mirror`)
    for (const f of FEATURES) {
      const got = applyColumnMajor(placed, rel(f))
      const want = sceneFromEnu(f)
      worst = Math.max(worst, Math.abs(got.x - want.x), Math.abs(got.y - want.y), Math.abs(got.z - want.z))
      // Read back as a position on Earth: the scene's east, north and up are metres from the origin, and the geodetic position of
      // that offset is the surveyed one (the feature's physical offset converted directly, by a path that has no scene in it).
      const back = enuToGeodetic({ ...LONDON, altitudeM: 0 }, enuFromScene(got))
      const surveyed = enuToGeodetic({ ...LONDON, altitudeM: 0 }, f)
      const mm = Math.hypot(((back.lat - surveyed.lat) * Math.PI / 180) * 6_378_137, ((back.lng - surveyed.lng) * Math.PI / 180) * 6_378_137 * Math.cos(LONDON.lat * Math.PI / 180)) * 1000
      worstMm = Math.max(worstMm, mm)
    }
  }
  assert(worst < 1e-9, `worst ${worst} m`)
  assert(worstMm < 1, `worst ${worstMm} mm`)
})

Deno.test('regression guard: the same placement in (east, up, north) is a mirror, and this test can tell', () => {
  // A right-handed session carried into a z-north frame by a rotation alone cannot land where the oracle says: the defect D8 removes.
  const landmarkAt: Enu = { east: 0, north: 0, up: 0 }
  const markerAt: Enu = { east: 2.4, north: 1.9, up: 0 }
  const placeBearing = bearingOfEnu({ east: markerAt.east, north: markerAt.north })
  const psi = 137
  const rel = (p: Enu): V3 => enuToSession(psi, p)
  const landmark = rel(landmarkAt)
  const marker = { ...rel(markerAt), y: landmark.y }
  const projectTransform = twoPointToProjectTransform(landmark, marker)
  // The legacy composition: yaw = the bearing itself, axes (east, up, north).
  const legacy = multiplyColumnMajor(composeYUpTransform({ x: 0, y: 0, z: 0 }, placeBearing, 1), projectTransform)
  let worst = 0
  for (const f of FEATURES) {
    const got = applyColumnMajor(legacy, rel(f))
    worst = Math.max(worst, Math.hypot(got.x - f.east, got.y - f.up, got.z - f.north))
  }
  assert(worst > 1, `the legacy composition was off by only ${worst} m`)
  // And the scene composition is exact for the same input.
  const scene = multiplyColumnMajor(composeYUpTransform({ x: 0, y: 0, z: 0 }, sceneYawForBearingDeg(placeBearing), 1), projectTransform)
  for (const f of FEATURES) {
    const got = applyColumnMajor(scene, rel(f))
    const want = sceneFromEnu(f)
    assertAlmostEquals(Math.hypot(got.x - want.x, got.y - want.y, got.z - want.z), 0, 1e-9)
  }
})

// ── placeSceneScan: calibrated scans ─────────────────────────────────────────

const PROJECT_TRANSFORM = twoPointToProjectTransform({ x: 1.5, y: -1.2, z: -0.4 }, { x: 3.1, y: -1.2, z: 1.9 })

function context(extra: Partial<WorldPlacementContext> = {}): WorldPlacementContext {
  return {
    convention: 'scene',
    georeference: null,
    georefVersion: 0,
    frameMethod: 'two-point-ground',
    worldOrigin: pose(LONDON.lat, LONDON.lng, { accuracyM: 4 }),
    maxRadiusM: 250,
    ...extra,
  }
}

function facts(extra: Partial<ScanPlacementFacts> = {}): ScanPlacementFacts {
  return { geoPose: pose(null, null), projectTransform: null, calibrationMethod: undefined, geoSession: null, ...extra }
}

const calibrated = (extra: Partial<ScanPlacementFacts> = {}) => facts({ projectTransform: PROJECT_TRANSFORM, calibrationMethod: 'two-point-ground', ...extra })

Deno.test('placeSceneScan: a calibrated scan of a Place with no georeference sits at its projectTransform as it is, in the Place frame, with no position on Earth to be unsure of', () => {
  const placed = placeSceneScan(calibrated(), context(), 3)
  assertEquals(placed.matrix, PROJECT_TRANSFORM.map((n) => n + 0), 'the matrix, bit for bit')
  assertEquals(placed.source, 'place-frame')
  assertEquals(placed.uncertaintyM, null)
  assertEquals(placed.gridReason, null)
  assertEquals(placed.geoDistanceM, null, 'no fix, no distance')
  // The fix and the compass play no part, however good or bad: it is calibrated.
  const withFix = placeSceneScan(calibrated({ geoPose: pose(LONDON.lat + 0.0004, LONDON.lng, { accuracyM: 3 }) }), context(), 3)
  assertEquals(withFix.matrix, placed.matrix)
  assertAlmostEquals(withFix.geoDistanceM!, 44.5, 0.1)
})

Deno.test('placeSceneScan: through a georeference a calibrated scan is carried onto the map, and says how far it may be out', () => {
  const record = georef({ bearingDeg: 75, bearingAccuracyDeg: 2, origin: { ...LONDON, altitudeM: null, accuracyM: 3.5 } })
  const ctx = context({ georeference: record, georefVersion: 2, worldOrigin: georeferenceOriginAsGeoPose(record) })
  const placed = placeSceneScan(calibrated(), ctx, 0)
  assertEquals(placed.source, 'georeference')
  assertEquals(placed.matrix, placeCalibratedScan(record, LONDON, PROJECT_TRANSFORM))
  // The scan's origin is where its session began in the Place frame: the translation of its projectTransform. The uncertainty is the
  // georeference's at that distance.
  const r = Math.hypot(PROJECT_TRANSFORM[12]!, PROJECT_TRANSFORM[14]!)
  assertEquals(placed.uncertaintyM, accuracyAt(record, r))
  assert(placed.uncertaintyM! > 3.5, 'a bearing sigma adds to the origin accuracy')
  // The matrix is the product the ADR states, built here by hand from enu.ts and the scene yaw.
  const hand = multiplyColumnMajor(composeYUpTransform(sceneFromEnu({ east: 0, north: 0, up: 0 }), 180 - 75, 1), PROJECT_TRANSFORM)
  for (let i = 0; i < 16; i++) assertAlmostEquals(placed.matrix[i]!, hand[i]!, 1e-12, `element ${i}`)
  // The record's origin is the world's origin: a world file whose own origin is stale does not move the scan.
  const stale = placeSceneScan(calibrated(), { ...ctx, worldOrigin: pose(48.85, 2.35) }, 0)
  assertEquals(stale.matrix, placed.matrix)
})

Deno.test('placeSceneScan: only a scan in the Place frame is carried by the Place georeference', () => {
  const record = georef({ bearingDeg: 75 })
  const ctx = context({ georeference: record, georefVersion: 1, worldOrigin: georeferenceOriginAsGeoPose(record) })
  // A one-point scan of a two-point Place is in another frame (it differs by the baseline's bearing): as it is, and nothing said.
  const onePoint = placeSceneScan(calibrated({ calibrationMethod: 'ground-tap-compass' }), ctx, 0)
  assertEquals(onePoint.matrix, PROJECT_TRANSFORM.map((n) => n + 0))
  assertEquals(onePoint.source, null)
  assertEquals(placementFields(onePoint), {}, 'no stamp: absence is not a claim')
  // A known-distance matrix is the camera solve's own coordinates, never a Place frame.
  assertEquals(placeSceneScan(calibrated({ calibrationMethod: 'known-distance' }), ctx, 0).source, null)
  // A calibration with no tier named is not provably in the frame.
  assertEquals(placeSceneScan(calibrated({ calibrationMethod: undefined }), ctx, 0).source, null)
  // A Place with no stored frame has nothing for a scan to differ from: any tier a frame can have is in it.
  assertEquals(placeSceneScan(calibrated({ calibrationMethod: 'ground-tap-compass' }), { ...ctx, frameMethod: null }, 0).source, 'georeference')
  assertEquals(inPlaceFrame('two-point-ground', 'ground-tap-compass'), false)
  assertEquals(inPlaceFrame('ground-tap-compass', 'ground-tap-compass'), true)
  assertEquals(inPlaceFrame(undefined, null), false)
})

// ── placeSceneScan: uncalibrated scans ───────────────────────────────────────

const START = '2026-11-17T10:00:00.000Z'
const STARTED_MS = Date.parse(START)

function session(extra: Partial<GeoSession> = {}, bearing: Partial<NonNullable<GeoSession['bearing']>> | null = {}): GeoSession {
  return {
    v: 1,
    startedAt: START,
    fix: { offsetS: 12, sessionX: 0.4, sessionZ: -0.2 },
    bearing: bearing === null
      ? null
      : { deg: 200, spreadDeg: 6, sigmaDeg: 15, samples: 30, spanS: 9, source: 'android-absolute', ...bearing },
    declination: { deg: 1.2, model: 'WMM2025', year: 2026.88 },
    ...extra,
  }
}

/** A scan with a fix `east` and `north` metres from the world's origin, taken a few seconds into the walk. */
function located(east: number, north: number, extra: Partial<GeoPose> = {}, geoSession: GeoSession | null = session()): ScanPlacementFacts {
  const at = enuToGeodetic({ ...LONDON, altitudeM: 0 }, { east, north, up: 0 })
  return facts({
    geoPose: pose(at.lat, at.lng, { accuracyM: 6, altitudeM: 12.5, bearing: 321, fixedAt: new Date(STARTED_MS + 12_000).toISOString(), ...extra }),
    geoSession,
  })
}

Deno.test('placeSceneScan: a scan with no calibration is placed by its fix and the session compass, and every feature lands where the oracle says', () => {
  // A session starts at a spot facing psi; its compass reads the session +Z's true bearing; its fix is at the session origin.
  const site: Enu = { east: 21.5, north: -13.25, up: 0 }
  let worst = 0
  for (const psi of [0, 10, 137, 200, 290, 359]) {
    const bz = trueSessionZBearing(psi)
    const scan = located(site.east, site.north, {}, session({ fix: null }, { deg: bz }))
    const placed = placeSceneScan(scan, context(), 0)
    assertEquals(placed.source, 'gps-compass')
    assertEquals(placed.gridReason, null)
    assertAlmostEquals(rotationDeterminant(placed.matrix), 1, 1e-12)
    for (const f of FEATURES) {
      const got = applyColumnMajor(placed.matrix, enuToSession(psi, f))
      const want = sceneFromEnu({ east: site.east + f.east, north: site.north + f.north, up: f.up })
      worst = Math.max(worst, Math.hypot(got.x - want.x, got.y - want.y, got.z - want.z))
    }
  }
  // Through two geodetic conversions the answer is a few nanometres from the oracle's.
  assert(worst < 1e-7, `worst ${worst} m`)
})

Deno.test('placeSceneScan: the height is the Place floor, never a GPS altitude, and a null altitude is not a 0 that moves a scan', () => {
  const heights = [null, 0, 12.5, -30, 400, 25_000]
  const matrices = heights.map((altitudeM) => placeSceneScan(located(10, 20, { altitudeM }), context(), 0).matrix)
  for (const m of matrices) {
    assertEquals(m[13], 0, 'y is the Place floor')
    assertEquals(m, matrices[0], 'the altitude changes nothing')
  }
  // Nor does the origin's: a world whose origin is at 80 m and a scan at 3 m are not 77 m apart.
  const high = placeSceneScan(located(10, 20), context({ worldOrigin: pose(LONDON.lat, LONDON.lng, { altitudeM: 80, accuracyM: 4 }) }), 0)
  assertEquals(high.matrix[13], 0)
})

Deno.test('placeSceneScan: the lever arm of a long walk is added back, and only past 3 m', () => {
  // The fix is where the phone was 40 s in; the camera had moved from the session origin by (sessionX, sessionZ). The session origin is
  // that position taken back by the offset, turned into east and north by the session's own bearing (+Z at 90 here: east).
  const bearing = 90
  const camera = { x: 0, z: 8 }   // 8 m along +Z, which is east at this bearing
  const fixAt = { east: 100, north: 50 }
  const scan = located(fixAt.east, fixAt.north, {}, session({ fix: { offsetS: 40, sessionX: camera.x, sessionZ: camera.z } }, { deg: bearing, sigmaDeg: 15 }))
  const placed = placeSceneScan(scan, context(), 0)
  assertAlmostEquals(placed.matrix[12]!, 100 - 8, 1e-6)
  assertAlmostEquals(placed.matrix[14]!, -50, 1e-6, 'north is unchanged: z is south')
  // The uncertainty grows by the bearing's error at that distance: 8 m times 15 degrees.
  assertAlmostEquals(placed.uncertaintyM!, Math.hypot(seedOriginAccuracyM(6), 8 * 15 * Math.PI / 180), 1e-9)
  // Under 3 m it is left alone: the correction would add a bearing error to a position that was near enough.
  const near = placeSceneScan(located(fixAt.east, fixAt.north, {}, session({ fix: { offsetS: 5, sessionX: 2, sessionZ: 2 } }, { deg: bearing })), context(), 0)
  assertAlmostEquals(near.matrix[12]!, 100, 1e-6)
  assertEquals(near.uncertaintyM, seedOriginAccuracyM(6))
  // Past 3 m and not at it: a camera exactly 3 m from the session origin is left alone, one a hair farther is not.
  const exactly = (distance: number) => placeSceneScan(located(fixAt.east, fixAt.north, {}, session({ fix: { offsetS: 5, sessionX: 0, sessionZ: distance } }, { deg: bearing })), context(), 0)
  assertAlmostEquals(exactly(3).matrix[12]!, 100, 1e-6, 'exactly 3 m is not past 3 m')
  assertEquals(exactly(3).uncertaintyM, seedOriginAccuracyM(6))
  assertAlmostEquals(exactly(3.001).matrix[12]!, 100 - 3.001, 1e-6, 'a millimetre past it is corrected')
  // And a fix with no position in the session has no lever arm to add.
  const unknown = placeSceneScan(located(fixAt.east, fixAt.north, {}, session({ fix: { offsetS: 40, sessionX: null, sessionZ: null } }, { deg: bearing })), context(), 0)
  assertAlmostEquals(unknown.matrix[12]!, 100, 1e-6)
})

Deno.test('placeSceneScan: each gate sends a scan to the grid with no yaw, naming why, and each passes at its edge', () => {
  const ctx = context()
  const grid = (scan: ScanPlacementFacts, index = 4) => placeSceneScan(scan, ctx, index)
  const reasonOf = (scan: ScanPlacementFacts) => grid(scan).gridReason

  assertEquals(reasonOf(located(10, 10)), null, 'the control passes')
  // Accuracy: 25 m is the limit, and none is none.
  assertEquals(reasonOf(located(10, 10, { accuracyM: 25 })), null)
  assertEquals(reasonOf(located(10, 10, { accuracyM: 25.1 })), 'fix-accuracy')
  assertEquals(reasonOf(located(10, 10, { accuracyM: null })), 'no-accuracy')
  assertEquals(reasonOf(located(10, 10, { accuracyM: 0 })), 'no-accuracy')
  assertEquals(reasonOf(located(10, 10, { accuracyM: Number.NaN })), 'no-accuracy')
  // Age: a fix within 60 s of the walk's beginning is usable, before it or after it, and one farther from it either way is not. Before:
  // the phone's last fix is stale. After: it is where the phone then was, and nothing carries it back to where the session began
  // (the capture records the best fix of the first minute with the camera's position, and no later one).
  const fixed = (secondsBefore: number) => new Date(STARTED_MS - secondsBefore * 1000).toISOString()
  assertEquals(reasonOf(located(10, 10, { fixedAt: fixed(60) })), null)
  assertEquals(reasonOf(located(10, 10, { fixedAt: fixed(60.5) })), 'fix-age')
  assertEquals(reasonOf(located(10, 10, { fixedAt: fixed(0) })), null, 'a fix taken as the walk began')
  assertEquals(reasonOf(located(10, 10, { fixedAt: fixed(-60) })), null, 'a fix 60 s into the walk is the last of the first minute')
  assertEquals(reasonOf(located(10, 10, { fixedAt: fixed(-60.5) })), 'fix-age', 'half a second past it is not')
  assertEquals(reasonOf(located(10, 10, { fixedAt: fixed(-300) })), 'fix-age', 'five minutes in is a position the walk has left behind')
  assertEquals(reasonOf(located(10, 10, { fixedAt: null })), 'fix-age', 'a fix with no time has no age to judge')
  assertEquals(reasonOf(located(10, 10, { fixedAt: 'yesterday' })), 'fix-age')
  // Spread: 30 degrees is the limit.
  assertEquals(reasonOf(located(10, 10, {}, session({}, { spreadDeg: 30, sigmaDeg: 30 }))), null)
  assertEquals(reasonOf(located(10, 10, {}, session({}, { spreadDeg: 30.1, sigmaDeg: 30.1 }))), 'bearing-spread')
  // No bearing: none recorded, or no session at all (a sidecar from before sessions were sampled holds a device heading, not the session's).
  assertEquals(reasonOf(located(10, 10, {}, session({}, null))), 'no-bearing')
  assertEquals(reasonOf(located(10, 10, {}, null)), 'no-bearing')
  // No fix, and no origin to measure from.
  assertEquals(reasonOf(facts({ geoSession: session() })), 'no-fix')
  assertEquals(reasonOf(facts({ geoPose: pose(0, 0, { accuracyM: 3 }), geoSession: session() })), 'no-fix')
  assertEquals(placeSceneScan(located(10, 10), context({ worldOrigin: pose(null, null) }), 0).gridReason, 'no-origin')
  // The radius: 250 m by default, from the origin.
  assertEquals(reasonOf(located(249, 0)), null)
  const far = grid(located(260, 0))
  assertEquals(far.gridReason, 'outlier')
  assertEquals(far.geoOutlier, true)
  assertAlmostEquals(far.geoDistanceM!, 260, 1e-3)
  assertEquals(placeSceneScan(located(260, 0), context({ maxRadiusM: 300 }), 0).gridReason, null)

  // On the grid: the slot of its index, no yaw however the phone was pointing, no height, and no claim about where it is.
  const placed = grid(located(10, 10, { accuracyM: 90, bearing: 123 }), 8)
  assertEquals(placed.source, 'grid')
  assertEquals(placed.matrix, gridMatrix(8))
  assertEquals([placed.matrix[12], placed.matrix[13], placed.matrix[14]], [6, 0, 3])
  for (const i of [0, 5, 10, 15]) assertEquals(placed.matrix[i], 1)
  for (const i of [1, 2, 4, 6, 8, 9]) assertEquals(placed.matrix[i], 0)
  assertEquals(placed.uncertaintyM, null)
  assertEquals(gridMatrix(0).slice(12, 15), [0, 0, 0])
  assertEquals(gridMatrix(5).slice(12, 15), [15, 0, 0])
  assertEquals(gridMatrix(6).slice(12, 15), [0, 0, 3])
  assert(gridMatrix(2).every((n) => !Object.is(n, -0)))
})

Deno.test('placeSceneScan: the uncertainty of a placement by GPS and compass is the seed rule on the fix accuracy', () => {
  for (const accuracy of [3, 10, 10.1, 20, 25]) {
    assertEquals(placeSceneScan(located(10, 10, { accuracyM: accuracy }, session({ fix: null })), context(), 0).uncertaintyM, seedOriginAccuracyM(accuracy), `accuracy ${accuracy}`)
  }
  assertEquals(seedOriginAccuracyM(3), 10, 'a fix of 3 m is claimed at 10, never 3')
})

Deno.test('placementFields and legacyPlacementStamps: what the manifest says, left off rather than nulled', () => {
  assertEquals(placementFields(placeSceneScan(calibrated(), context(), 0)), { placementSource: 'place-frame', placementUncertaintyM: null })
  assertEquals(placementFields(placeSceneScan(located(10, 10), context(), 0)), { placementSource: 'gps-compass', placementUncertaintyM: 10 })
  assertEquals(placementFields(placeSceneScan(facts(), context(), 0)), { placementSource: 'grid', placementUncertaintyM: null })
  // The legacy convention: the matrix is the previous build's and untouched; this says only what put it there.
  const legacy = (f: ScanPlacementFacts, distance: number | null, outlier = false, frame: PlaceFacts['frameMethod'] = 'two-point-ground') =>
    legacyPlacementStamps(f, frame, { geoDistanceM: distance, geoOutlier: outlier })
  assertEquals(legacy(calibrated(), 12), { placementSource: 'place-frame', placementUncertaintyM: null })
  assertEquals(legacy(calibrated({ calibrationMethod: 'ground-tap-compass' }), 12), {}, 'another frame: nothing said')
  // A GPS placement of the previous build is the phone's own heading in mirrored axes: it says what put the scan there and no figure.
  assertEquals(legacy(located(10, 10, { accuracyM: 4 }), 12), { placementSource: 'gps-compass', placementUncertaintyM: null })
  assertEquals(legacy(located(10, 10, { accuracyM: 40 }), 12), { placementSource: 'gps-compass', placementUncertaintyM: null })
  assertEquals(legacy(located(10, 10, { accuracyM: null }), 12), { placementSource: 'gps-compass', placementUncertaintyM: null })
  assertEquals(legacy(located(300, 0), 300, true), { placementSource: 'grid', placementUncertaintyM: null })
  assertEquals(legacy(facts(), null), { placementSource: 'grid', placementUncertaintyM: null })
})

Deno.test('placeStoredScan: a world of the scene places the scan, a legacy world keeps what the caller computed and is only stamped, and no context says nothing', () => {
  const caller = { geoDistanceM: 17.5, geoOutlier: false }
  const sidecar = { geoSession: session({ fix: null }, { deg: 200 }) }
  const geo = located(10, 20).geoPose

  // The scene: the placement decides the matrix, the distance and the stamps, and the caller's numbers are not used.
  const scene = placeStoredScan(context(), sidecar, geo, null, caller, 4)
  const decided = placeSceneScan(located(10, 20, {}, session({ fix: null }, { deg: 200 })), context(), 4)
  assertEquals(scene.matrix, decided.matrix)
  assertAlmostEquals(scene.geoDistanceM!, Math.hypot(10, 20), 0.01)
  assertEquals(scene.geoOutlier, false)
  assertEquals(scene.stamps, { placementSource: 'gps-compass', placementUncertaintyM: 10 })
  // A scene scan that is calibrated is stamped place-frame, and one that fails a gate stands on the grid (slot 4: 12 m along x).
  assertEquals(placeStoredScan(context(), { calibrationMethod: 'two-point-ground' }, pose(null, null), PROJECT_TRANSFORM, caller, 0).stamps, { placementSource: 'place-frame', placementUncertaintyM: null })
  const grid = placeStoredScan(context(), {}, pose(null, null), null, caller, 4)
  assertEquals(grid.matrix, gridMatrix(4))
  assertEquals(grid.stamps, { placementSource: 'grid', placementUncertaintyM: null })

  // A legacy world: no matrix of its own (the caller keeps the one it computed), the caller's distance and outlier flag, and a stamp.
  const legacy = placeStoredScan(context({ convention: 'legacy' }), sidecar, geo, null, caller, 4)
  assertEquals(legacy.matrix, null)
  assertEquals([legacy.geoDistanceM, legacy.geoOutlier], [17.5, false])
  assertEquals(legacy.stamps, { placementSource: 'gps-compass', placementUncertaintyM: null }, 'no figure: the previous build placed it by the phone\'s own heading')
  assertEquals(placeStoredScan(context({ convention: 'legacy' }), sidecar, geo, null, { geoDistanceM: 300, geoOutlier: true }, 4).stamps, { placementSource: 'grid', placementUncertaintyM: null })

  // No context (a caller with no Place to ask): nothing is said and nothing changes.
  const none = placeStoredScan(undefined, sidecar, geo, null, caller, 4)
  assertEquals(none, { matrix: null, geoDistanceM: 17.5, geoOutlier: false, stamps: {} })
})

// ── The Place as placement reads it ──────────────────────────────────────────

const registryPlace = (extra: Partial<Project> = {}): Project => ({
  projectId: 'proj-1',
  name: 'Kitchen',
  createdAt: 1,
  updatedAt: 2,
  floors: [],
  ...extra,
})

Deno.test('createWorldPlacing: a refused georeference is ignored and warned of once for each reason, a registry that cannot be read is not a Place with none, and the context and host carry what main.ts gave', async () => {
  const warnings: string[] = []
  const good = registryPlace({ projectId: 'proj-good', georeference: georef(), georefVersion: 1 })
  const bearingOut = registryPlace({ projectId: 'proj-bad', georeference: { ...georef(), bearingDeg: 500 }, georefVersion: 2 })
  let registry: Project[] | Error = [good, bearingOut]
  const meta: Record<string, unknown> = { geoLat: 1 }
  const placing = createWorldPlacing({
    loadProjects: () => (registry instanceof Error ? Promise.reject(registry) : Promise.resolve(registry)),
    warn: (message) => warnings.push(message),
    maxRadiusM: 123,
    geoPoseFor: () => pose(5, 6),
    matrixFor: () => null,
  })

  // The facts of a Place. A good record is its facts; a refused one is no georeference, and is warned of once for each Place and reason.
  assertEquals(placing.factsOfProject(good).georeference, georef())
  assertEquals(warnings, [])
  for (let read = 0; read < 3; read++) assertEquals(placing.factsOfProject(bearingOut).georeference, null)
  assertEquals(warnings.length, 1, 'the same reason is not logged on every read')
  assert(warnings[0]!.includes('proj-bad') && warnings[0]!.includes('bearingDeg'), warnings[0])
  const latitudeOut = registryPlace({ projectId: 'proj-bad', georeference: { ...georef(), origin: { ...georef().origin, lat: 95 } }, georefVersion: 2 })
  placing.factsOfProject(latitudeOut)
  assertEquals(warnings.length, 2, 'another reason for the same Place is')
  assertEquals(placing.factsOfProject(null), { georeference: null, georefVersion: 0, frameMethod: null })

  // The facts of a world's Place.
  const world = (projectId: string | null): WorldProject => ({ ...legacyWorld(), projectId })
  assertEquals((await placing.factsOfWorld(world('proj-good')))!.georeference, georef())
  assertEquals(await placing.factsOfWorld(world('proj-unknown')), { georeference: null, georefVersion: 0, frameMethod: null }, 'a Place that is not in the registry has none')
  assertEquals(await placing.factsOfWorld(world(null)), { georeference: null, georefVersion: 0, frameMethod: null }, 'a world with no Place has none')
  // A registry that cannot be read this moment is not a Place with no georeference: null, so the caller changes nothing.
  registry = new Error('disk gone')
  warnings.length = 0
  assertEquals(await placing.factsOfWorld(world('proj-good')), null)
  assertEquals(warnings.length, 1)
  assert(warnings[0]!.includes('disk gone'), warnings[0])
  // A world with no Place never needed the registry, so an unreadable one changes nothing for it, and is not warned of again.
  assertEquals(await placing.factsOfWorld(world(null)), { georeference: null, georefVersion: 0, frameMethod: null })
  assertEquals(warnings.length, 1)

  // What the hooks are handed.
  const facts1: PlaceFacts = { georeference: georef(), georefVersion: 2, frameMethod: 'two-point-ground' }
  const ctx = placing.context(world('proj-good'), facts1)
  assertEquals([ctx.maxRadiusM, ctx.georefVersion, ctx.frameMethod, ctx.convention], [123, 2, 'two-point-ground', 'legacy'])
  const hosted = placing.host((filename) => (filename === 'a.glb' ? meta : undefined))
  assertEquals(hosted.maxRadiusM, 123)
  assertEquals(hosted.metaFor('a.glb'), meta)
  assertEquals(hosted.metaFor('b.glb'), undefined)
  assertEquals(hosted.geoPoseFor(meta), pose(5, 6))
  assertEquals(hosted.matrixFor([1]), null)
})

Deno.test('placeFactsFor: the georeference when it passes the validator, its version, and the method of the stored frame', () => {
  assertEquals(placeFactsFor(null), { georeference: null, georefVersion: 0, frameMethod: null })
  assertEquals(placeFactsFor(registryPlace()), { georeference: null, georefVersion: 0, frameMethod: null })
  const record = georef()
  const facts1 = placeFactsFor(registryPlace({ georeference: record, georefVersion: 3, spatialFrame: { version: 1, createdAt: '2026-11-17T09:00:00.000Z', method: 'ground-tap-compass', anchorBearingDeg: null } }))
  assertEquals(facts1, { georeference: record, georefVersion: 3, frameMethod: 'ground-tap-compass' })
  // A record the registry file holds that the validator would not take is no georeference: the file is one a person can edit.
  const heard: string[] = []
  const bad = placeFactsFor(registryPlace({ georeference: { ...record, bearingDeg: 500 }, georefVersion: 2 }), (reason) => heard.push(reason))
  assertEquals(bad, { georeference: null, georefVersion: 0, frameMethod: null })
  assertEquals(heard.length, 1)
  assert(heard[0]!.includes('bearingDeg'))
  // A version with no record, or a record with no version, reads as the version 0 and the record it has.
  assertEquals(placeFactsFor(registryPlace({ georefVersion: 4 })).georefVersion, 0)
  assertEquals(placeFactsFor(registryPlace({ georeference: record })).georefVersion, 0)
  assertEquals(worldConvention({ localFrame: { type: 'ENU_Y_UP', origin: pose(null, null), units: 'meters', axes: { x: 'east', y: 'up', z: 'south' } } }), 'scene')
  assertEquals(worldConvention({ localFrame: { type: 'ENU_Y_UP', origin: pose(null, null), units: 'meters', axes: { x: 'east', y: 'up', z: 'north' } } }), 'legacy')
  assertEquals(worldConvention({} as WorldProject), 'legacy', 'a world file with no frame is a legacy one')
})

// ── A world and its georeference ─────────────────────────────────────────────

const PLACEMENT_PATCH = (patchId: string, scanId: string, matrix: number[], revertsPatchId?: string): EditPatch => ({
  patchId,
  worldId: 'world-test',
  scanId,
  targetId: `${scanId}.glb`,
  scope: 'scan',
  transform: { matrix, position: { x: matrix[12]!, y: matrix[13]!, z: matrix[14]! }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
  actorId: 'tester',
  ...(revertsPatchId ? { revertsPatchId } : {}),
  createdAt: '2026-11-17T09:30:00.000Z',
})

function row(name: string, matrix: number[], extra: Partial<ScanManifest> = {}): ScanManifest {
  return {
    scanId: `scan-${name}`,
    projectId: 'proj-1',
    sessionId: null,
    filename: `${name}.glb`,
    name,
    glbUrl: `/scans/${name}.glb`,
    geoPose: pose(null, null),
    localToWorld: matrix,
    accuracyM: null,
    geoDistanceM: null,
    capturedAt: null,
    pointCount: null,
    detectionCount: null,
    layerIndex: [],
    status: 'ready',
    ...extra,
  }
}

/** A legacy world (z: 'north') whose five scans were placed by the previous build, as the golden world is. */
function legacyWorld(): WorldProject {
  const old = (x: number) => rotateYThenMove(0, { x, y: 0, z: 0 })
  return {
    worldId: 'world-test',
    name: 'Kitchen',
    shareSlug: 'project-proj-1',
    projectId: 'proj-1',
    originGeoPose: pose(51.50075, -0.12455, { accuracyM: 4 }),
    localFrame: { type: 'ENU_Y_UP', origin: pose(51.50075, -0.12455), units: 'meters', axes: { x: 'east', y: 'up', z: 'north' } },
    scans: [
      row('cal-a', old(1), { calibratedLocalToWorld: old(1) }),
      row('cal-b', old(2), { calibratedLocalToWorld: old(1) }),
      row('gps-c', old(3), { calibratedLocalToWorld: old(3) }),
      row('gps-d', old(4), { calibratedLocalToWorld: old(7) }),
      row('ingest-e', old(5)),
    ],
    things: [],
    thingObservations: [],
    members: [],
    jobs: [],
    editPatches: [
      PLACEMENT_PATCH('p-b', 'scan-cal-b', old(2)),
      PLACEMENT_PATCH('p-d', 'scan-gps-d', old(4)),
    ],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  }
}

/** The sidecars of those scans, and the readers the host hands the module. */
function host(overrides: Record<string, Record<string, unknown>> = {}): PlacementHost {
  const at = (east: number, north: number) => enuToGeodetic({ ...LONDON, altitudeM: 0 }, { east, north, up: 0 })
  const gps = (east: number, north: number) => {
    const g = at(east, north)
    return { geoLat: g.lat, geoLng: g.lng, geoAccuracy: 5, geoAltitudeM: 9, geoBearing: 77, geoFixedAt: new Date(STARTED_MS + 8000).toISOString() }
  }
  const sessionMeta = { geoSession: session({ fix: null }, { deg: 250 }) }
  const metas: Record<string, Record<string, unknown>> = {
    'cal-a.glb': { projectTransform: PROJECT_TRANSFORM, calibrationMethod: 'two-point-ground', ...gps(5, 5) },
    'cal-b.glb': { projectTransform: PROJECT_TRANSFORM, calibrationMethod: 'two-point-ground' },
    'gps-c.glb': { ...gps(30, -12), ...sessionMeta },
    'gps-d.glb': { ...gps(-20, 8), ...sessionMeta },
    ...overrides,
  }
  return {
    maxRadiusM: 250,
    metaFor: (filename) => metas[filename],
    geoPoseFor: (meta) => pose(
      typeof meta['geoLat'] === 'number' ? meta['geoLat'] : null,
      typeof meta['geoLng'] === 'number' ? meta['geoLng'] : null,
      {
        accuracyM: typeof meta['geoAccuracy'] === 'number' ? meta['geoAccuracy'] : null,
        altitudeM: typeof meta['geoAltitudeM'] === 'number' ? meta['geoAltitudeM'] : null,
        fixedAt: typeof meta['geoFixedAt'] === 'string' ? meta['geoFixedAt'] : null,
      },
    ),
    matrixFor: (value) => (Array.isArray(value) && value.length === 16 && value.every((n) => typeof n === 'number' && Number.isFinite(n)) ? [...value] as number[] : null),
  }
}

const frameFacts = (record: ProjectGeoreference | null, version: number): PlaceFacts => ({ georeference: record, georefVersion: version, frameMethod: 'two-point-ground' })
const byName = (world: WorldProject, name: string) => world.scans.find((scan) => scan.name === name)!

Deno.test('applyPlaceGeoreference: a new version places the unpatched scans again, flags the ones a person moved, and moves nothing else', () => {
  const world = legacyWorld()
  const before = JSON.parse(JSON.stringify(world)) as WorldProject
  const record = georef({ bearingDeg: 75 })
  const place = frameFacts(record, 1)

  assertEquals(applyPlaceGeoreference(world, place, host()), true)

  // The world is the scene now, with the record's origin, and says under which version its placements were made.
  assertEquals(world.localFrame.axes.z, 'south')
  assertEquals(world.localFrame.origin, georeferenceOriginAsGeoPose(record))
  assertEquals(world.originGeoPose, georeferenceOriginAsGeoPose(record))
  assertEquals(world.georefVersion, 1)
  assertEquals(world.georeference, record)

  const ctx = placementContext(world, place, 250)
  const h = host()
  const expected = (name: string, index: number) => {
    const meta = h.metaFor(`${name}.glb`)!
    return placeSceneScan({
      geoPose: h.geoPoseFor(meta),
      projectTransform: h.matrixFor(meta['projectTransform']),
      calibrationMethod: meta['calibrationMethod'] as never,
      geoSession: (meta['geoSession'] ?? null) as GeoSession | null,
    }, ctx, index)
  }

  // Unpatched: placed again, stamped, and what they started as follows.
  const a = byName(world, 'cal-a')
  assertEquals(a.localToWorld, expected('cal-a', 0).matrix)
  assertNotEquals(a.localToWorld, before.scans[0]!.localToWorld)
  assertEquals(a.placementSource, 'georeference')
  assertEquals(typeof a.placementUncertaintyM, 'number')
  assertEquals(a.calibratedLocalToWorld, a.localToWorld, 'reset to calibrated goes where the georeference puts it')
  assertEquals(a.placementStale, undefined)
  const c = byName(world, 'gps-c')
  assertEquals(c.localToWorld, expected('gps-c', 2).matrix)
  assertEquals(c.placementSource, 'gps-compass')
  assertEquals(c.calibratedLocalToWorld, c.localToWorld)
  assertAlmostEquals(c.localToWorld[12]!, 30, 1e-6)
  assertAlmostEquals(c.localToWorld[14]!, 12, 1e-6, 'north 12 south is z 12... the fix was 12 m south of the origin, so z is +12')

  // Moved by hand: exactly where the person left them, flagged, with the new calibrated placement to go back to.
  for (const [name, index] of [['cal-b', 1], ['gps-d', 3]] as const) {
    const scan = byName(world, name)
    assertEquals(scan.localToWorld, before.scans[index]!.localToWorld, `${name} did not move`)
    assertEquals(scan.placementStale, true, `${name} is flagged`)
    assertEquals(scan.calibratedLocalToWorld, expected(name, index).matrix, `${name}: reset to calibrated is the new placement`)
  }
  // A session-backed scan with no sidecar on disk has nothing to be placed by: untouched.
  assertEquals(byName(world, 'ingest-e'), before.scans[4])
  // Nothing else in the world is touched: the patches, the jobs, the members.
  assertEquals(world.editPatches, before.editPatches)
  assertEquals(world.things, before.things)
})

Deno.test('applyPlaceGeoreference: the same version again changes nothing, and a new one places the unpatched scans against the new record', () => {
  const world = legacyWorld()
  const record = georef({ bearingDeg: 75 })
  assertEquals(applyPlaceGeoreference(world, frameFacts(record, 1), host()), true)
  const settled = JSON.parse(JSON.stringify(world)) as WorldProject

  // Same version, same record: nothing to do, nothing written.
  assertEquals(applyPlaceGeoreference(world, frameFacts(record, 1), host()), false)
  assertEquals(world, settled)

  // The same version with a record that differs (the registry edited by hand): the world takes the record, and moves no scan.
  const edited = georef({ bearingDeg: 76 })
  assertEquals(applyPlaceGeoreference(world, frameFacts(edited, 1), host()), true)
  assertEquals(world.georeference, edited)
  assertEquals(byName(world, 'cal-a').localToWorld, byName(settled, 'cal-a').localToWorld)

  // A new version: the unpatched scans follow the new bearing; the patched ones stay and stay flagged.
  const turned = georef({ bearingDeg: 120, origin: { lat: 51.5008, lng: -0.1244, altitudeM: null, accuracyM: 3.5 } })
  assertEquals(applyPlaceGeoreference(world, frameFacts(turned, 2), host()), true)
  assertEquals(world.georefVersion, 2)
  assertEquals(world.originGeoPose.lat, 51.5008)
  assertNotEquals(byName(world, 'cal-a').localToWorld, byName(settled, 'cal-a').localToWorld)
  const calibrationAt = (bearing: number) => placeCalibratedScan(georef({ bearingDeg: bearing, origin: turned.origin }), turned.origin, PROJECT_TRANSFORM)
  assertEquals(byName(world, 'cal-a').localToWorld, calibrationAt(120))
  assertEquals(byName(world, 'cal-b').localToWorld, byName(settled, 'cal-b').localToWorld, 'the scan a person moved did not move')
  assertEquals(byName(world, 'cal-b').placementStale, true)
  assertEquals(byName(world, 'cal-b').calibratedLocalToWorld, calibrationAt(120))
})

Deno.test('applyPlaceGeoreference: a scan nobody has moved, an undo that left no move, and a move that already is where the georeference puts it, are none of them stale', () => {
  const record = georef({ bearingDeg: 75 })
  const place = frameFacts(record, 1)
  const target = placeCalibratedScan(record, LONDON, PROJECT_TRANSFORM)

  // A move that was undone leaves no live placement patch (the undo record names it): the scan is placed again.
  const world = legacyWorld()
  world.editPatches = [
    PLACEMENT_PATCH('p-b', 'scan-cal-b', rotateYThenMove(0, { x: 2, y: 0, z: 0 })),
    PLACEMENT_PATCH('u-b', 'scan-cal-b', rotateYThenMove(0, { x: 1, y: 0, z: 0 }), 'p-b'),
  ]
  applyPlaceGeoreference(world, place, host())
  assertEquals(byName(world, 'cal-b').localToWorld, target, 'an undone move is no move')
  assertEquals(byName(world, 'cal-b').placementStale, undefined)

  // A person's move that happens to be exactly the georeference's placement is not stale: there is nothing out of date about it.
  const exact = legacyWorld()
  exact.scans[1]!.localToWorld = [...target]
  exact.editPatches = [PLACEMENT_PATCH('p-b', 'scan-cal-b', target)]
  applyPlaceGeoreference(exact, place, host())
  assertEquals(byName(exact, 'cal-b').localToWorld, target)
  assertEquals(byName(exact, 'cal-b').placementStale, undefined)
})

Deno.test('applyPlaceGeoreference: a scan of another frame is not carried by the georeference, so a move of it is not stale', () => {
  const world = legacyWorld()
  const other = host({ 'cal-b.glb': { projectTransform: PROJECT_TRANSFORM, calibrationMethod: 'ground-tap-compass' } })
  applyPlaceGeoreference(world, frameFacts(georef({ bearingDeg: 75 }), 1), other)
  const scan = byName(world, 'cal-b')
  assertEquals(scan.placementStale, undefined, 'patched, but nothing about it is out of date')
  assertEquals(scan.localToWorld, legacyWorld().scans[1]!.localToWorld, 'and it did not move')
  assertEquals(scan.calibratedLocalToWorld, PROJECT_TRANSFORM.map((n) => n + 0), 'its calibrated placement is its calibration as it is')
  // The unpatched one of the same kind sits at its calibration as it is, and says nothing about itself.
  const world2 = legacyWorld()
  applyPlaceGeoreference(world2, frameFacts(georef({ bearingDeg: 75 }), 1), host({ 'cal-a.glb': { projectTransform: PROJECT_TRANSFORM, calibrationMethod: 'ground-tap-compass' } }))
  assertEquals(byName(world2, 'cal-a').localToWorld, PROJECT_TRANSFORM.map((n) => n + 0))
  assertEquals(byName(world2, 'cal-a').placementSource, undefined)
})

Deno.test('applyPlaceGeoreference: a Place that has lost its georeference keeps every placement, and forgets the record', () => {
  const world = legacyWorld()
  applyPlaceGeoreference(world, frameFacts(georef({ bearingDeg: 75 }), 1), host())
  const placed = world.scans.map((scan) => scan.localToWorld)
  assertEquals(applyPlaceGeoreference(world, frameFacts(null, 0), host()), true)
  assertEquals(world.georeference, undefined)
  assertEquals(world.georefVersion, undefined)
  assertEquals(world.scans.map((scan) => scan.localToWorld), placed, 'nothing was moved: there is no record of where they were')
  // Nothing registers the scans now: they stop saying they are on the map, and a flag about a registration that is gone goes with it.
  assert(world.scans.every((scan) => scan.placementSource !== 'georeference' && scan.placementStale === undefined), 'no scan claims a registration the world no longer has')
  assertEquals(byName(world, 'cal-a').placementSource, undefined)
  assertEquals(byName(world, 'cal-a').placementUncertaintyM, undefined)
  assertEquals(byName(world, 'gps-c').placementSource, 'gps-compass', 'what a fix and a compass placed is still said')
  assertEquals(applyPlaceGeoreference(world, frameFacts(null, 0), host()), false, 'and it is not done twice')
  // The version counter is the world's, so a georeference that comes back as version 1 places the world again.
  assertEquals(applyPlaceGeoreference(world, frameFacts(georef({ bearingDeg: 10 }), 1), host()), true)
  assertEquals(byName(world, 'cal-a').localToWorld, placeCalibratedScan(georef({ bearingDeg: 10 }), LONDON, PROJECT_TRANSFORM))
})

Deno.test('applyPlaceGeoreference: a world with no georeference and no stamp is left exactly as it is, and a legacy world is not touched until one arrives', () => {
  const world = legacyWorld()
  const before = JSON.parse(JSON.stringify(world))
  assertEquals(applyPlaceGeoreference(world, frameFacts(null, 0), host()), false)
  assertEquals(world, before, 'a legacy world with a Place that has no georeference: nothing is recomputed, silently or otherwise')
})

Deno.test('originIfMissing: a scene world that never had an origin takes its best located scan, and nothing else moves', () => {
  const sceneFrame = (z: 'north' | 'south', origin: GeoPose) => ({ type: 'ENU_Y_UP' as const, origin, units: 'meters' as const, axes: { x: 'east' as const, y: 'up' as const, z } })
  const candidates = [{ geoPose: pose(51.6, -0.1, { accuracyM: 20 }) }, { geoPose: pose(51.7, -0.2, { accuracyM: 5 }) }]
  const world = { ...legacyWorld(), originGeoPose: pose(null, null), localFrame: sceneFrame('south', pose(null, null)) }
  const scans = JSON.stringify(world.scans)
  assertEquals(originIfMissing(world, frameFacts(null, 0), candidates), true)
  assertEquals(world.originGeoPose.lat, 51.7, 'the best accuracy')
  assertEquals(world.localFrame.origin.lat, 51.7)
  assertEquals(JSON.stringify(world.scans), scans)
  // Once it has one it keeps it, a legacy world is never given one, and a world with a georeference takes it from there.
  assertEquals(originIfMissing(world, frameFacts(null, 0), [{ geoPose: pose(40, 1, { accuracyM: 1 }) }]), false)
  const legacy = { ...legacyWorld(), originGeoPose: pose(null, null) }
  assertEquals(originIfMissing(legacy, frameFacts(null, 0), candidates), false)
  assertEquals(hasLat(legacy.originGeoPose), false)
  const georeferenced = { ...legacyWorld(), originGeoPose: pose(null, null), localFrame: sceneFrame('south', pose(null, null)) }
  assertEquals(originIfMissing(georeferenced, frameFacts(georef(), 1), candidates), false)
  assertEquals(originIfMissing({ ...world, originGeoPose: pose(null, null) }, frameFacts(null, 0), [{ geoPose: pose(null, null) }]), false)
})

const hasLat = (p: GeoPose) => p.lat !== null

Deno.test('settleWorldPlacementStamps: what a matrix and a sidecar prove is stamped, what they do not is left unsaid, and a reset clears the flag', () => {
  const place = frameFacts(null, 0)
  const world = legacyWorld()
  // cal-a sits at its projectTransform; cal-b is somewhere else (it was moved); gps-c has no calibration.
  world.scans[0]!.localToWorld = [...PROJECT_TRANSFORM]
  world.scans[1]!.localToWorld = rotateYThenMove(10, { x: 9, y: 0, z: 9 })
  assertEquals(settleWorldPlacementStamps(world, place, host()), true)
  assertEquals(byName(world, 'cal-a').placementSource, 'place-frame')
  assertEquals(byName(world, 'cal-a').placementUncertaintyM, null)
  assertEquals(byName(world, 'cal-b').placementSource, undefined, 'a matrix that is not the calibration proves nothing')
  assertEquals(byName(world, 'gps-c').placementSource, undefined, 'a GPS placement of the previous build is not provable either')
  assertEquals(byName(world, 'ingest-e').placementSource, undefined)
  // Nothing more to do on the next read.
  assertEquals(settleWorldPlacementStamps(world, place, host()), false)

  // A scan of another frame is never stamped place-frame.
  const other = legacyWorld()
  other.scans[0]!.localToWorld = [...PROJECT_TRANSFORM]
  assertEquals(settleWorldPlacementStamps(other, { ...place, frameMethod: 'ground-tap-compass' }, host()), false)
  assertEquals(byName(other, 'cal-a').placementSource, undefined)

  // A georeferenced Place is not backfilled: its calibrated scans carry a stamp from the placement that made them.
  const georeferenced = legacyWorld()
  georeferenced.scans[0]!.localToWorld = [...PROJECT_TRANSFORM]
  assertEquals(settleWorldPlacementStamps(georeferenced, frameFacts(georef(), 1), host()), false)

  // The flag clears when the scan is at its calibrated placement again.
  const stale = legacyWorld()
  stale.scans[1]!.placementStale = true
  stale.scans[1]!.localToWorld = [...stale.scans[1]!.calibratedLocalToWorld!]
  assertEquals(settleWorldPlacementStamps(stale, place, host()), true)
  assertEquals(byName(stale, 'cal-b').placementStale, undefined)
  // And stays while it is somewhere else.
  const still = legacyWorld()
  still.scans[1]!.placementStale = true
  settleWorldPlacementStamps(still, place, host())
  assertEquals(byName(still, 'cal-b').placementStale, true)
})

Deno.test('withStoredPlacementStamps: a row keeps the stamps it has, and the absence of the ones it has not, so a refresh cannot describe a matrix the row does not hold', () => {
  const stored = row('x', identityMatrix(), { placementSource: 'georeference', placementUncertaintyM: 4.2, placementStale: true })
  const fresh = row('x', identityMatrix(), { placementSource: 'grid', placementUncertaintyM: null })
  const merged = withStoredPlacementStamps({ ...fresh }, stored)
  assertEquals([merged.placementSource, merged.placementUncertaintyM, merged.placementStale], ['georeference', 4.2, true], 'laid over the new manifest, the stored stamps win')
  // A row from the previous build has none, and a manifest built now must not give it one: the matrix is not the one it describes.
  const old = row('y', identityMatrix())
  const lent = withStoredPlacementStamps({ ...row('y', identityMatrix(), { placementSource: 'gps-compass', placementUncertaintyM: 10 }) }, old)
  assertEquals(Object.keys(lent).filter((key) => key.startsWith('placement')), [], 'no placement key at all')
})

Deno.test('calibratedPlacement: what a scan\'s calibration puts it at under the Place, which is what "reset to calibrated" returns to', () => {
  const record = georef({ bearingDeg: 75 })
  const withRecord = context({ georeference: record, worldOrigin: georeferenceOriginAsGeoPose(record) })
  assertEquals(calibratedPlacement(calibrated(), withRecord), placeCalibratedScan(record, LONDON, PROJECT_TRANSFORM))
  assertEquals(calibratedPlacement(calibrated(), context()), PROJECT_TRANSFORM, 'no georeference: the calibration as it is')
  assertEquals(calibratedPlacement(calibrated({ calibrationMethod: 'ground-tap-compass' }), withRecord), PROJECT_TRANSFORM, 'another frame: as it is')
  assertEquals(calibratedPlacement(facts(), withRecord), undefined, 'no calibration: the first placement is the row\'s own')
  assertEquals(calibratedPlacement(null, withRecord), undefined)
  // The context reads the world's own fields.
  const world = legacyWorld()
  assertEquals(placementContext(world, frameFacts(record, 2), 99), {
    convention: 'legacy',
    georeference: record,
    georefVersion: 2,
    frameMethod: 'two-point-ground',
    worldOrigin: world.originGeoPose,
    maxRadiusM: 99,
  })
})

Deno.test('buildGeoreference is what the numeric panel saves, and what is saved places a scan', () => {
  // End to end through the pure modules: numbers a person typed, a record, a placement. The bearing is folded, the record validates.
  const record = buildGeoreference({ ...LONDON, originAccuracyM: 3.5, bearingDeg: -330, bearingAccuracyDeg: 1, source: 'typed', anchorRef: null, now: new Date('2026-11-17T10:00:00Z'), confirmed: true })
  assertEquals(record.bearingDeg, 30)
  const placed = placeCalibratedScan(record, LONDON, identityMatrix())
  // Place +Z is bearing 30: its scene direction is (sin 30, 0, -cos 30).
  const z = applyColumnMajor(placed, { x: 0, y: 0, z: 1 })
  assertAlmostEquals(z.x, Math.sin(Math.PI / 6), 1e-12)
  assertAlmostEquals(z.z, -Math.cos(Math.PI / 6), 1e-12)
  assertAlmostEquals(angDiff(bearingOfEnu(enuFromScene({ x: z.x, y: 0, z: z.z })), 30), 0, 1e-9)
  // The geodetic offset of the scene's (0, 0, 0) is the record's origin.
  const o = enuToGeodetic({ ...LONDON, altitudeM: 0 }, enuFromScene({ x: placed[12]!, y: 0, z: placed[14]! }))
  assertAlmostEquals(o.lat, LONDON.lat, 1e-12)
  assertAlmostEquals(geodeticToEnu({ ...LONDON, altitudeM: 0 }, o).east, 0, 1e-9)
})

// ── What the review of this package found ────────────────────────────────────

/** A world of the scene with its scans placed under version 1 (bearing 75) and no patches, the way a world is after its first georeference. */
function sceneWorld(): WorldProject {
  const world = legacyWorld()
  world.editPatches = []
  applyPlaceGeoreference(world, frameFacts(georef({ bearingDeg: 75 }), 1), host())
  return world
}

/** What saving a move does (applyPatchToWorld in server/main.ts): the patch joins the log, and the scan's matrix is the patch's. */
function move(world: WorldProject, name: string, matrix: number[], patchId: string, revertsPatchId?: string): void {
  world.editPatches.push(PLACEMENT_PATCH(patchId, `scan-${name}`, matrix, revertsPatchId))
  byName(world, name).localToWorld = [...matrix]
}

const nudged = (matrix: number[], dx: number) => matrix.map((n, i) => (i === 12 ? n + dx : n))

Deno.test('applyPlaceGeoreference: a version that changes nothing for a scan a person placed is no news: a registration confirmed with every number as it was, and an origin that moved', () => {
  const world = sceneWorld()
  const a = byName(world, 'cal-a')
  const placedAt = [...a.localToWorld]
  const nudge = nudged(placedAt, 0.05)
  move(world, 'cal-a', nudge, 'p-nudge')
  assertEquals(a.placementStale, undefined)

  // Saved as approximate and then confirmed with every number as it was: version 2, the same geometry. The person's move was made from
  // this very placement.
  const confirmed = georef({ bearingDeg: 75, registeredAt: '2026-11-17T11:00:00.000Z', confirmedAt: '2026-11-17T11:00:00.000Z' })
  assertEquals(applyPlaceGeoreference(world, frameFacts(confirmed, 2), host()), true)
  assertEquals(world.georefVersion, 2)
  assertEquals(a.localToWorld, nudge, 'it did not move')
  assertEquals(a.placementStale, undefined, 'and nothing about its position is out of date')
  assertEquals(a.calibratedLocalToWorld, placedAt, 'reset to calibrated is where it was')

  // The origin moved and the bearing did not: the scene moves with it (its (0, 0, 0) is the origin), the calibrated scans keep their
  // scene matrices, and a scan a person placed in that scene is where it was in it.
  const shifted = georef({ bearingDeg: 75, origin: { lat: 51.5008, lng: -0.1244, altitudeM: null, accuracyM: 3.5 }, registeredAt: '2026-11-17T12:00:00.000Z' })
  assertEquals(applyPlaceGeoreference(world, frameFacts(shifted, 3), host()), true)
  assertEquals(a.localToWorld, nudge)
  assertEquals(a.placementStale, undefined, 'an origin that moved with the whole scene is no news')
  assertEquals(byName(world, 'cal-b').placementSource, 'georeference')

  // The bearing turned: now the georeference puts it somewhere else than where it put it, and it is out of date, and does not move.
  const turned = georef({ bearingDeg: 120, origin: shifted.origin, registeredAt: '2026-11-17T13:00:00.000Z' })
  applyPlaceGeoreference(world, frameFacts(turned, 4), host())
  assertEquals(a.localToWorld, nudge)
  assertEquals(a.placementStale, true)
  assertEquals(a.calibratedLocalToWorld, placeCalibratedScan(turned, turned.origin, PROJECT_TRANSFORM))
})

Deno.test('applyPlaceGeoreference: a scan reset to its calibration follows the next georeference, and the patch log replays to where the server put it', () => {
  const world = sceneWorld()
  const a = byName(world, 'cal-a')
  const calibrated1 = [...a.calibratedLocalToWorld!]
  move(world, 'cal-a', nudged(calibrated1, 1.5), 'p-move')
  move(world, 'cal-a', calibrated1, 'p-reset')   // "Reset to calibrated": an ordinary patch carrying the stored matrix
  assertEquals(liveScanPlacementPatches(world.editPatches, a).length, 2, 'the log still holds both')

  const turned = georef({ bearingDeg: 120, registeredAt: '2026-11-17T13:00:00.000Z' })
  assertEquals(applyPlaceGeoreference(world, frameFacts(turned, 2), host()), true)
  const target = placeCalibratedScan(turned, turned.origin, PROJECT_TRANSFORM)
  assertEquals(a.localToWorld, target, 'a reset scan is at its calibration: nobody placed it, so it follows')
  assertEquals(a.placementStale, undefined)
  assertEquals(a.placementSource, 'georeference')
  assertEquals(a.calibratedLocalToWorld, target)
  // The moves still holding it are taken back by records the server writes, as an undo does, carrying where it put the scan.
  assertEquals(liveScanPlacementPatches(world.editPatches, a), [], 'no move counts any more')
  const written = world.editPatches.filter((patch) => patch.actorId === GEOREFERENCE_ACTOR)
  assertEquals(written.map((patch) => patch.revertsPatchId).sort(), ['p-move', 'p-reset'])
  assertEquals(new Set(world.editPatches.map((patch) => patch.patchId)).size, world.editPatches.length, 'every patch id is its own')
  for (const patch of written) {
    assertEquals(patch.transform!.matrix, target)
    assertEquals([patch.scanId, patch.targetId, patch.worldId, patch.scope], [a.scanId, a.filename, world.worldId, 'scan'])
  }
  // The editor replays the log over the world's matrix, and lands where the server put the scan.
  assertEquals(replayedScanPlacement(world.editPatches, a), a.localToWorld)
  // A person placed nothing: the next georeference moves it again, and writes nothing more (no move holds it).
  const before = world.editPatches.length
  applyPlaceGeoreference(world, frameFacts(georef({ bearingDeg: 200, registeredAt: '2026-11-17T14:00:00.000Z' }), 3), host())
  assertEquals(a.localToWorld, placeCalibratedScan(georef({ bearingDeg: 200 }), LONDON, PROJECT_TRANSFORM))
  assertEquals(world.editPatches.length, before)
  assertEquals(replayedScanPlacement(world.editPatches, a), a.localToWorld)
  // A reset when the georeference changes nothing for the scan: nothing to take back, no record.
  const quiet = sceneWorld()
  const q = byName(quiet, 'cal-a')
  move(quiet, 'cal-a', nudged(q.calibratedLocalToWorld!, 1), 'p-move')
  move(quiet, 'cal-a', q.calibratedLocalToWorld!, 'p-reset')
  applyPlaceGeoreference(quiet, frameFacts(georef({ bearingDeg: 75, registeredAt: '2026-11-17T15:00:00.000Z', confirmedAt: '2026-11-17T15:00:00.000Z' }), 2), host())
  assertEquals(quiet.editPatches.length, 2)
  assertEquals(replayedScanPlacement(quiet.editPatches, q), q.localToWorld)
})

Deno.test('applyPlaceGeoreference: a scan whose only move was undone follows the next georeference, and the editor does not replay the undo record over it', () => {
  const world = sceneWorld()
  const a = byName(world, 'cal-a')
  const first = [...a.localToWorld]
  move(world, 'cal-a', nudged(first, 1.5), 'p-move')
  move(world, 'cal-a', first, 'u-move', 'p-move')   // the undo: an ordinary patch carrying the placement the scan went back to, and naming the move
  assertEquals(liveScanPlacementPatches(world.editPatches, a), [])

  const turned = georef({ bearingDeg: 200, registeredAt: '2026-11-17T13:00:00.000Z' })
  applyPlaceGeoreference(world, frameFacts(turned, 2), host())
  const target = placeCalibratedScan(turned, turned.origin, PROJECT_TRANSFORM)
  assertEquals(a.localToWorld, target)
  assertEquals(a.placementStale, undefined)
  assertNotEquals(world.editPatches.at(-1)!.transform!.matrix, target, 'the undo record still carries the placement of version 1: it is the log\'s, and nothing is written over it')
  assertEquals(replayedScanPlacement(world.editPatches, a), target, 'but the editor draws the scan where the world says it is')
  // The naive replay of every scan patch in order (what the editor did) lands on the undo record's matrix: the old placement, 125 degrees out.
  const naive = world.editPatches.filter((patch) => patch.scope === 'scan').at(-1)!.transform!.matrix
  assertNotEquals(naive, target)
})

Deno.test('applyPlaceGeoreference: Things and their observations follow the scans that were placed again, and no others', () => {
  const world = sceneWorld()
  const a = byName(world, 'cal-a')
  const b = byName(world, 'cal-b')
  // A chair the scan saw 2 m ahead of its session origin, worked out at the placement of version 1, as the correspondence job does.
  const local = { x: 0.4, y: 0.9, z: 2 }
  const at1 = transformPoint(a.localToWorld, local)
  const thing = (id: string, scanId: string, position: Thing['position'], origin: Thing['origin'] = 'matcher'): Thing => ({
    thingId: id, worldId: world.worldId, canonicalLabel: 'chair', representativeTargetId: `${scanId}:Chair_001:lod`, position, firstSeenScanId: scanId, lastSeenScanId: scanId,
    observationIds: [`obs-${id}`], createdAt: '2026-11-17T09:00:00.000Z', updatedAt: '2026-11-17T09:00:00.000Z', origin,
  })
  const observation = (id: string, scanId: string, worldPos: Thing['position']): ThingObservation => ({
    observationId: `obs-${id}`, thingId: id, scanId, sessionId: null, targetId: `${scanId}:Chair_001:lod`, label: 'chair', canonicalLabel: 'chair', confidence: 0.8, worldPos, observedAt: null, origin: 'matcher',
  })
  const stay = { x: 9, y: 0, z: 9 }
  world.things = [thing('t-a', a.scanId, at1), thing('t-user', a.scanId, at1, 'user'), thing('t-b', b.scanId, stay)]
  world.thingObservations = [observation('t-a', a.scanId, at1), observation('t-b', b.scanId, stay)]
  const cDistance = (p: Thing['position'], q: Thing['position']) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)

  // cal-b is a scan a person placed: it does not move, so what it saw does not.
  move(world, 'cal-b', nudged(b.localToWorld, 0.5), 'p-b')

  const turned = georef({ bearingDeg: 200, registeredAt: '2026-11-17T13:00:00.000Z' })
  applyPlaceGeoreference(world, frameFacts(turned, 2), host())
  const at2 = transformPoint(a.localToWorld, local)
  assert(cDistance(at1, at2) > 1, 'the scan moved metres')
  for (const record of [world.things[0]!.position, world.things[1]!.position, world.thingObservations[0]!.worldPos]) {
    assert(cDistance(record, at2) < 1e-9, `${JSON.stringify(record)} is where the scan\'s detection is now: ${JSON.stringify(at2)}`)
  }
  assertEquals(world.things[2]!.position, stay, 'the Thing of a scan a person placed stays with it')
  assertEquals(world.thingObservations[1]!.worldPos, stay)
  // Nothing else of a Thing changes.
  assertEquals([world.things[0]!.thingId, world.things[0]!.origin, world.things[0]!.firstSeenScanId, world.things[0]!.observationIds], ['t-a', 'matcher', a.scanId, ['obs-t-a']])
  // The inverse is exact: the carry is `new x inverse(old)`, so going back to the first bearing puts the chair back where it began.
  applyPlaceGeoreference(world, frameFacts(georef({ bearingDeg: 75, registeredAt: '2026-11-17T14:00:00.000Z' }), 3), host())
  assert(cDistance(world.things[0]!.position, at1) < 1e-9, 'and back')
  assert(invertAffine(a.localToWorld) !== null)
})

Deno.test('placeFactsFor and placeSceneScan: a registration made for another alignment of the Place is not used, and a scan of an earlier alignment is not carried by this one', () => {
  const frame = (frameId?: string) => ({ version: 1 as const, createdAt: '2026-11-17T09:00:00.000Z', method: 'two-point-ground' as const, landmark: { x: 0, y: 0, z: 0 }, headingMarker: { x: 0, y: 0, z: 2 }, separationM: 2, toleranceM: 0.15, anchorBearingDeg: null, ...(frameId ? { frameId } : {}) })
  const heard: string[] = []
  const forFrame = (anchorRef: string | null, frameId?: string) => placeFactsFor(registryPlace({ georeference: georef({ anchorRef }), georefVersion: 3, spatialFrame: frame(frameId) }), (reason) => heard.push(reason))
  // Both ids known and the same: the record stands, and the facts carry the frame's id.
  const matching = forFrame('frame-a', 'frame-a')
  assertEquals(matching.georeference?.anchorRef, 'frame-a')
  assertEquals(matching.frameId, 'frame-a')
  assertEquals(matching.georefVersion, 3)
  // Both known and different: the Place's alignment was made again after the location was saved. The record is not used.
  const replaced = forFrame('frame-a', 'frame-b')
  assertEquals(replaced.georeference, null)
  assertEquals(replaced.georefVersion, 0)
  assertEquals(replaced.frameId, 'frame-b')
  assertEquals(heard.length, 1)
  assert(heard[0]!.includes('another alignment'), heard[0])
  // An id on one side only says nothing: the record stands.
  assertEquals(forFrame(null, 'frame-b').georeference?.anchorRef, null)
  assertEquals(forFrame('frame-a').georeference?.anchorRef, 'frame-a')
  assertEquals('frameId' in forFrame('frame-a'), false, 'no id on the frame: the key is not there, so the facts are what they were')
  assertEquals(heard.length, 1)

  // A scan of an earlier generation of the frame is not in this one: the georeference does not carry it, and nothing is said of it.
  const record = georef({ bearingDeg: 75, anchorRef: 'frame-b' })
  const ctx = context({ georeference: record, georefVersion: 1, worldOrigin: georeferenceOriginAsGeoPose(record), frameId: 'frame-b' })
  const current = placeSceneScan(calibrated({ calibrationFrameId: 'frame-b' }), ctx, 0)
  assertEquals(current.source, 'georeference')
  const earlier = placeSceneScan(calibrated({ calibrationFrameId: 'frame-a' }), ctx, 0)
  assertEquals(earlier.source, null)
  assertEquals(earlier.matrix, PROJECT_TRANSFORM.map((n) => n + 0), 'as it was calibrated')
  assertEquals(earlier.uncertaintyM, null)
  assertEquals(placeSceneScan(calibrated({ calibrationFrameId: 'frame-a' }), { ...ctx, frameId: undefined }, 0).source, 'georeference', 'the Place\'s frame has no id: neutral')
  assertEquals(placeSceneScan(calibrated(), ctx, 0).source, 'georeference', 'a scan calibrated before ids existed is neutral too')
  assertEquals(calibratedPlacement(calibrated({ calibrationFrameId: 'frame-a' }), ctx), PROJECT_TRANSFORM, 'and what a reset returns to is its calibration as it is')
  // The sidecar says which generation: the flat key or the record.
  assertEquals(scanPlacementFacts({ calibrationMethod: 'two-point-ground', calibrationFrameId: 'frame-a' }, pose(null, null), null).calibrationFrameId, 'frame-a')
  assertEquals(scanPlacementFacts({ calibrationMethod: 'two-point-ground', calibration: { method: 'two-point-ground', frameId: 'frame-c' } }, pose(null, null), null).calibrationFrameId, 'frame-c')
  assertEquals('calibrationFrameId' in scanPlacementFacts({ calibrationMethod: 'ground-tap-compass' }, pose(null, null), null), false)
  // The legacy stamps and the stamp backfill know it too.
  assertEquals(legacyPlacementStamps(calibrated({ calibrationFrameId: 'frame-a' }), 'two-point-ground', { geoDistanceM: null, geoOutlier: false }, 'frame-b'), {})
  assertEquals(legacyPlacementStamps(calibrated({ calibrationFrameId: 'frame-b' }), 'two-point-ground', { geoDistanceM: null, geoOutlier: false }, 'frame-b'), { placementSource: 'place-frame', placementUncertaintyM: null })
})

Deno.test('placeFactsFor: a floor a later measurement raises does not make a Place forget its registration: the record is kept and claims no better than the floor', () => {
  const record = georef({ bearingDeg: 75 })
  const floor = ACCURACY_FLOORS['map-click'] as { originM: number; bearingDeg: number }
  const was = { ...floor }
  const heard: string[] = []
  try {
    floor.originM = 5
    floor.bearingDeg = 2
    const facts1 = placeFactsFor(registryPlace({ georeference: record, georefVersion: 4 }), (reason) => heard.push(reason))
    assertEquals(heard, [], 'nothing is refused')
    assertEquals(facts1.georefVersion, 4, 'and the version is the Place\'s')
    assertEquals([facts1.georeference!.origin.accuracyM, facts1.georeference!.bearingAccuracyDeg], [5, 2], 'held to the floors of today')
    // What a scan is placed with says so: through the record it is out by the larger claim.
    const ctx = context({ georeference: facts1.georeference, georefVersion: 4, worldOrigin: georeferenceOriginAsGeoPose(facts1.georeference!) })
    assertEquals(placeSceneScan(calibrated(), ctx, 0).uncertaintyM, accuracyAt(facts1.georeference!, Math.hypot(PROJECT_TRANSFORM[12]!, PROJECT_TRANSFORM[14]!)))
  } finally {
    floor.originM = was.originM
    floor.bearingDeg = was.bearingDeg
  }
  // Not well formed is still refused.
  placeFactsFor(registryPlace({ georeference: { ...record, source: 'psychic' } as never, georefVersion: 1 }), (reason) => heard.push(reason))
  assertEquals(heard.length, 1)
})

Deno.test('a random sequence of moves, resets, undos and new georeferences never lets the editor and the server disagree about where a scan is', () => {
  // The invariant this package's review found broken twice (an undo record, a reset): the editor draws a scan by replaying the patch log
  // over the world's matrix, so for every scan `replayedScanPlacement(log, scan)` must be the scan's own `localToWorld`, however its log
  // got there. The operations are the real ones: a saved move (`applyPatchToWorld`: the patch joins the log and its matrix is the scan's),
  // "reset to calibrated" (an ordinary patch carrying the stored first placement), an undo (`planRevert` and `buildRevertPatch`, as the
  // route builds it), and a new georeference (`applyPlaceGeoreference`, which may move scans, flag them and write records of its own).
  let seed = 12345
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
  let patchNumber = 0
  const names = ['cal-a', 'cal-b', 'gps-c', 'gps-d']
  // What the generator really did, so that the invariant is not held over a sequence that never reached the hard cases.
  const seen = { moves: 0, resets: 0, undos: 0, georeferences: 0, serverRecords: 0, stale: 0 }
  for (let run = 0; run < 150; run++) {
    const world = legacyWorld()
    world.editPatches = []
    let version = 0
    const apply = (bearing: number, origin: { lat: number; lng: number }, confirmed: boolean) => {
      version += 1
      const record = georef({
        bearingDeg: bearing,
        origin: { ...origin, altitudeM: null, accuracyM: 3.5 },
        registeredAt: new Date(Date.UTC(2026, 10, 17, 10, version)).toISOString(),
        ...(confirmed ? { confirmedAt: new Date(Date.UTC(2026, 10, 17, 10, version)).toISOString() } : {}),
      })
      const before = new Map(world.scans.map((scan) => [scan.name, { matrix: [...scan.localToWorld], hand: isHandPlacedNow(world, scan) }]))
      applyPlaceGeoreference(world, frameFacts(record, version), host())
      for (const scan of world.scans) {
        const was = before.get(scan.name)!
        if (was.hand) assertEquals(scan.localToWorld, was.matrix, `run ${run}: ${scan.name} was placed by a person and did not move`)
        if (scan.placementStale) {
          assert(was.hand, `run ${run}: ${scan.name} is flagged stale, so a person placed it`)
          seen.stale += 1
        }
        if (!was.hand && scan.placementSource === 'georeference') assertEquals(scan.localToWorld, scan.calibratedLocalToWorld, `run ${run}: ${scan.name} follows its calibration`)
      }
    }
    apply(75, LONDON, false)
    for (let step = 0; step < 12; step++) {
      const name = pick(names)
      const scan = byName(world, name)
      const operation = pick(['move', 'move', 'reset', 'undo', 'georeference', 'georeference'] as const)
      if (operation === 'move') {
        patchNumber += 1
        seen.moves += 1
        move(world, name, nudged(scan.localToWorld, (random() - 0.5) * 6), `p-${patchNumber}`)
      } else if (operation === 'reset' && scan.calibratedLocalToWorld) {
        patchNumber += 1
        seen.resets += 1
        move(world, name, [...scan.calibratedLocalToWorld], `r-${patchNumber}`)
      } else if (operation === 'undo') {
        const plan = planRevert(world, { scanId: scan.scanId })
        if (plan.ok) {
          seen.undos += 1
          patchNumber += 1
          const patch = buildRevertPatch(world.worldId, plan, { patchId: `u-${patchNumber}`, actorId: 'tester', createdAt: '2026-11-17T09:30:00.000Z' })
          world.editPatches.push(patch)
          scan.localToWorld = [...patch.transform!.matrix!]
        }
      } else if (operation === 'georeference') {
        const bearing = pick([75, 75, 120, 200, 310])
        const origin = pick([LONDON, LONDON, { lat: 51.5008, lng: -0.1244 }])
        const hadRecords = world.editPatches.filter((patch) => patch.actorId === GEOREFERENCE_ACTOR).length
        seen.georeferences += 1
        apply(bearing, origin, random() < 0.5)
        seen.serverRecords += world.editPatches.filter((patch) => patch.actorId === GEOREFERENCE_ACTOR).length - hadRecords
      }
      for (const each of world.scans) {
        if (!each.calibratedLocalToWorld) continue
        assertEquals(replayedScanPlacement(world.editPatches, each), each.localToWorld, `run ${run} step ${step} (${operation} on ${name}): the editor draws ${each.name} where the server holds it`)
      }
    }
  }
  assert(seen.moves > 100 && seen.resets > 50 && seen.undos > 50 && seen.georeferences > 100, JSON.stringify(seen))
  assert(seen.serverRecords > 0, `a reset scan was placed again and its moves taken back: ${JSON.stringify(seen)}`)
  assert(seen.stale > 0, `a scan a person placed was flagged: ${JSON.stringify(seen)}`)
})

/** Whether a person placed the scan in the world as it stands (`isHandPlaced`, with the world's own log). */
function isHandPlacedNow(world: WorldProject, scan: ScanManifest): boolean {
  return liveScanPlacementPatches(world.editPatches, scan).length > 0 && !sameMatrix(scan.localToWorld, scan.calibratedLocalToWorld)
}
