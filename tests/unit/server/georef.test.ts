/**
 * The georeference record and its arithmetic (src/world/georef.ts): what may be stored, how sure it may say it is, and
 * what the bearing and the seeds come to. The exact geodesy is tests/unit/server/enu.test.ts's and
 * georef_vectors.test.ts's; the placement is world_origin.test.ts's. What is pinned here:
 *
 *  - the validator accepts what each source can honestly write and refuses everything else, with every reason;
 *  - the bearing of two map clicks is the angle on the ellipsoid, and the planar shortcut is not;
 *  - the predicted bearing error is R6's table, the propagated accuracy is the lateral-error table;
 *  - the Place bearing from a session's compass comes out true for every start heading, turn and tilt of a physical
 *    model that shares no code with the app (./physical_oracle.ts);
 *  - the GeoPose export is the Basic-Quaternion shape, with the quaternions R6 lists, and rotates a frame the way the
 *    Place frame is turned;
 *  - the seeds: the circular mean, the steady-sample rule, the best fix in the first minute, the sigma floors.
 */
import { assert, assertAlmostEquals, assertEquals } from './assert.ts'
import {
  ACCURACY_FLOORS,
  accuracyAt,
  baselineLengthM,
  BEARING_SIGMA_FLOOR_EDGE_DEG,
  BEARING_SIGMA_FLOOR_SEED_DEG,
  BEARING_SIGMA_FLOOR_SEED_IOS_DEG,
  BearingAccumulator,
  bearingFromClicks,
  bearingSeedFromSamples,
  type BearingSample,
  bestFixInWindow,
  buildGeoreference,
  circularStats,
  declinationRecord,
  frameOffsetToEnu,
  GEOPOSE_OBJECT_FRAME,
  GEOREFERENCE_FIELDS,
  GEOREFERENCE_SOURCES,
  georeferenceBlock,
  georeferenceFrameState,
  georeferenceOriginAsGeoPose,
  holdToFloors,
  inPlaceFrame,
  isConfirmedGeoreference,
  isGeorefVersion,
  MAX_REPORTED_PROBLEMS,
  MIN_BEARING_SAMPLES,
  ORIGIN_ACCURACY_FLOOR_IMAGERY_M,
  ORIGIN_ACCURACY_FLOOR_SEED_M,
  placeBearingSeed,
  placeFrameToScene,
  placeFrameToSceneFor,
  placeGeorefVersion,
  predictedBearingSigmaDeg,
  projectBearingFromSession,
  readStoredGeoreference,
  sameGeoreference,
  type SeedFix,
  seedOriginAccuracyM,
  toGeoPoseBasicQuaternion,
  validateGeoreference,
  wrapLongitudeDeg,
} from '../../../src/world/georef.ts'
import { enuToGeodetic } from '../../../src/world/enu.ts'
import {
  oneTapToProjectTransform,
  sessionFrameBearingDeg,
  twoPointHeadingDeg,
  twoPointToProjectTransform,
} from '../../../src/world/geo.ts'
import type { ProjectGeoreference } from '../../../src/world/types.ts'
import {
  angDiff,
  bearingOfEnu,
  cameraRotation,
  enuToSession,
  type Enu,
  perfectCompassBearing,
  rotateByQuat,
  trueSessionZBearing,
  type V3,
} from './physical_oracle.ts'
import { test } from 'node:test'

const NOW = Date.parse('2026-11-17T12:00:00.000Z')

/** A georeference a person made by clicking a map: London, a long wall, imagery-limited accuracy. */
function mapClick(extra: Partial<ProjectGeoreference> = {}): ProjectGeoreference {
  return {
    origin: { lat: 51.5007, lng: -0.1246, altitudeM: null, accuracyM: 3.5 },
    heightDatum: 'unknown',
    bearingDeg: 30,
    bearingAccuracyDeg: 1,
    convention: 2,
    datum: 'WGS84',
    source: 'map-click',
    registeredAt: '2026-11-17T10:00:00.000Z',
    confirmedAt: '2026-11-17T10:00:00.000Z',
    anchorRef: 'frame-1',
    ...extra,
  }
}

/** A compass seed, as the numeric panel builds one: approximate, not confirmed. */
function seed(extra: Partial<ProjectGeoreference> = {}): ProjectGeoreference {
  return {
    origin: { lat: 51.5007, lng: -0.1246, altitudeM: null, accuracyM: 25 },
    heightDatum: 'unknown',
    bearingDeg: 200,
    bearingAccuracyDeg: 25,
    convention: 2,
    datum: 'WGS84',
    source: 'gps-compass',
    declination: { deg: 1.2, model: 'WMM2025', year: 2026.88 },
    seed: { scans: 3, spreadDeg: 11.2, lowConfidence: false },
    registeredAt: '2026-11-17T10:00:00.000Z',
    anchorRef: null,
    ...extra,
  }
}

const ok = (value: unknown) => {
  const check = validateGeoreference(value, { now: NOW })
  assert(check.ok, check.ok ? '' : check.errors.join('; '))
  return check.georeference
}
const errorsOf = (value: unknown): string[] => {
  const check = validateGeoreference(value, { now: NOW })
  assert(!check.ok, 'the record should have been refused')
  assertEquals(check.error, check.errors[0], 'error is the first of the reasons')
  return check.errors
}
/** A record with a path set to `value`: `with(mapClick(), 'origin.lat', 91)`. */
function set(record: ProjectGeoreference, path: string, value: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(record)) as Record<string, unknown>
  const keys = path.split('.')
  let at = copy
  for (const key of keys.slice(0, -1)) at = at[key] as Record<string, unknown>
  if (value === undefined) delete at[keys.at(-1)!]
  else at[keys.at(-1)!] = value
  return copy
}

// ── validateGeoreference ──────────────────────────────────────────────────────

test('validateGeoreference: a record each source can honestly write is accepted, as a copy, and survives JSON', () => {
  const records: ProjectGeoreference[] = [
    mapClick(),
    mapClick({ source: 'footprint-snap' }),
    mapClick({ source: 'typed', bearingAccuracyDeg: 15 }),
    mapClick({ source: 'survey', origin: { lat: 51.5007, lng: -0.1246, altitudeM: 11.25, accuracyM: 0.05 }, heightDatum: 'ellipsoid', bearingAccuracyDeg: 0.1 }),
    seed(),
    seed({ source: 'course-over-ground', bearingAccuracyDeg: 5, origin: { lat: 51.5007, lng: -0.1246, altitudeM: null, accuracyM: 10 } }),
  ]
  for (const record of records) {
    const stored = ok(record)
    assertEquals(stored, record)
    assert(stored !== record, 'the copy is a new object: nothing the input holds can reach what is stored')
    assert(stored.origin !== record.origin)
    assertEquals(ok(JSON.parse(JSON.stringify(stored))), stored, 'and it is what comes back through JSON')
  }
  assertEquals(records.length, 6)
  assertEquals(new Set(records.map((r) => r.source)).size, 6, 'every source is exercised')
})

test('validateGeoreference: the field list and the source list say what the type says', () => {
  // The compile-time checks are in georef.ts; this is the run-time face of them, so a removed field fails here by name.
  assertEquals(Object.keys(GEOREFERENCE_FIELDS).sort(), [
    'anchorRef', 'bearingAccuracyDeg', 'bearingDeg', 'confirmedAt', 'convention', 'datum', 'declination', 'heightDatum', 'origin',
    'registeredAt', 'seed', 'source',
  ])
  assertEquals([...GEOREFERENCE_SOURCES].sort(), Object.keys(ACCURACY_FLOORS).sort(), 'every source has a floor')
  for (const field of Object.keys(mapClick())) assert(Object.hasOwn(GEOREFERENCE_FIELDS, field), field)
})

test('validateGeoreference: what is not an object, and what is not a field, is refused', () => {
  for (const value of [null, undefined, 'banana', 7, [], [mapClick()], new Date(), () => 1]) {
    assertEquals(errorsOf(value), ['georeference must be an object'], String(value))
  }
  assert(errorsOf({ ...mapClick(), banana: 1 }).includes('georeference.banana is not a field of a georeference'))
  assert(errorsOf({ ...mapClick(), origin: { ...mapClick().origin, hdop: 1 } }).includes('origin.hdop is not a field of a location'))
  // A key that reaches an object's prototype is never stored, from JSON or from code.
  const proto = JSON.parse(`{"__proto__":{"polluted":true},"origin":${JSON.stringify(mapClick().origin)}}`)
  assert(errorsOf(proto).includes('georeference has a field the server will not store'))
  assertEquals(({} as Record<string, unknown>)['polluted'], undefined)
})

test('validateGeoreference: the origin must be a place on the Earth, and says what is wrong', () => {
  const base = mapClick()
  const cases: Array<[string, string, unknown, string]> = [
    ['latitude above the pole guard', 'origin.lat', 90, 'origin.lat must be a number from -89.999 to 89.999'],
    ['latitude below it', 'origin.lat', -90, 'origin.lat must be a number from -89.999 to 89.999'],
    ['latitude as text', 'origin.lat', '51.5', 'origin.lat must be a number from -89.999 to 89.999'],
    ['longitude past 180', 'origin.lng', 181, 'origin.lng must be a number from -180 to 180'],
    ['longitude missing', 'origin.lng', undefined, 'origin.lng must be a number from -180 to 180'],
    ['altitude as text', 'origin.altitudeM', '11', 'origin.altitudeM must be a height in metres above the WGS-84 ellipsoid from -1000 to 850000, or null'],
    ['altitude missing', 'origin.altitudeM', undefined, 'origin.altitudeM must be a height in metres above the WGS-84 ellipsoid from -1000 to 850000, or null'],
    ['accuracy zero', 'origin.accuracyM', 0, 'origin.accuracyM must be a number above 0 (a radius in metres)'],
    ['accuracy negative', 'origin.accuracyM', -3, 'origin.accuracyM must be a number above 0 (a radius in metres)'],
    ['accuracy as text', 'origin.accuracyM', '5', 'origin.accuracyM must be a number above 0 (a radius in metres)'],
    ['accuracy past the cap', 'origin.accuracyM', 1000.5, 'origin.accuracyM must be at most 1000 m'],
  ]
  for (const [what, path, value, message] of cases) {
    assert(errorsOf(set(base, path, value)).includes(message), `${what}: ${errorsOf(set(base, path, value)).join(' | ')}`)
  }
  // JSON cannot carry NaN or Infinity, but a call from code can.
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert(errorsOf({ ...base, origin: { ...base.origin, lat: value } }).length > 0)
    assert(errorsOf({ ...base, origin: { ...base.origin, accuracyM: value } }).length > 0)
    assert(errorsOf({ ...base, bearingDeg: value }).length > 0)
  }
  // (0, 0) is how a missing location is written (`hasGeoPose` in ./geo.ts), so it is never a Place.
  assert(errorsOf({ ...base, origin: { ...base.origin, lat: 0, lng: 0 } }).some((m) => m.includes('latitude 0 and longitude 0')))
  // Either one on its own is a place: the equator, the prime meridian, the antimeridian.
  ok({ ...base, origin: { ...base.origin, lat: 0, lng: 36.8 } })
  ok({ ...base, origin: { ...base.origin, lat: -16.5, lng: 180 } })
  ok({ ...base, origin: { ...base.origin, lat: 51.5, lng: 0 } })
})

test('validateGeoreference: a height has a datum, and a phone altitude of unknown datum cannot be stored', () => {
  const base = mapClick()
  ok(set(base, 'origin.altitudeM', null))
  assert(errorsOf(set(base, 'origin.altitudeM', 11.5)).some((m) => m.includes("'ellipsoid'")), 'a number with datum unknown is refused')
  ok({ ...base, origin: { ...base.origin, altitudeM: 11.5 }, heightDatum: 'ellipsoid' })
  assert(errorsOf(set(base, 'heightDatum', 'ellipsoid')).some((m) => m.includes("'unknown'")), 'no height with datum ellipsoid is refused')
  assert(errorsOf(set(base, 'heightDatum', 'msl')).some((m) => m.includes('georeference.heightDatum')))
  assert(errorsOf(set(base, 'heightDatum', undefined)).some((m) => m.includes('georeference.heightDatum')))
})

test('validateGeoreference: no source claims better than it can (the floors), at the edge of each', () => {
  const base = mapClick()
  const originAt = (m: number) => ({ ...base.origin, accuracyM: m })
  // [source, the least origin accuracy, the least bearing sigma]
  const floors: Array<[ProjectGeoreference['source'], number, number]> = [
    ['map-click', 3.5, 1],
    ['footprint-snap', 3.5, 1],
    ['typed', 3.5, 1],
    ['survey', 0.05, 0.1],
    ['gps-compass', 10, 15],
    ['course-over-ground', 10, 5],
  ]
  for (const [source, origin, bearing] of floors) {
    assertEquals(ACCURACY_FLOORS[source], { originM: origin, bearingDeg: bearing }, `${source}: the table`)
    // At the floor: accepted.
    ok({ ...base, source, origin: originAt(origin), bearingAccuracyDeg: bearing })
    // Just under it: refused, naming the source.
    const underOrigin = errorsOf({ ...base, source, origin: originAt(origin * 0.99), bearingAccuracyDeg: bearing })
    assert(underOrigin.some((m) => m.startsWith('origin.accuracyM is below') && m.includes(`'${source}'`)), `${source}: ${underOrigin.join(' | ')}`)
    const underBearing = errorsOf({ ...base, source, origin: originAt(origin), bearingAccuracyDeg: bearing * 0.99 })
    assert(underBearing.some((m) => m.startsWith('georeference.bearingAccuracyDeg is below') && m.includes(`'${source}'`)), `${source}: ${underBearing.join(' | ')}`)
  }
  // The named constants are the table's numbers.
  assertEquals([ORIGIN_ACCURACY_FLOOR_IMAGERY_M, ORIGIN_ACCURACY_FLOOR_SEED_M, BEARING_SIGMA_FLOOR_EDGE_DEG, BEARING_SIGMA_FLOOR_SEED_DEG], [3.5, 10, 1, 15])
  // And a bearing's sigma has an upper bound: 180 says nothing is known.
  ok({ ...base, bearingAccuracyDeg: 180 })
  assert(errorsOf({ ...base, bearingAccuracyDeg: 181 }).some((m) => m.includes('at most 180')))
})

test('validateGeoreference: the bearing is in [0, 360), under the corrected sign rule, on WGS84', () => {
  const base = mapClick()
  for (const good of [0, 0.001, 30, 179.999, 359.999999]) ok({ ...base, bearingDeg: good })
  for (const bad of [-0.001, 360, 720, '30', null, undefined]) {
    assert(errorsOf({ ...base, bearingDeg: bad }).some((m) => m.startsWith('georeference.bearingDeg')), String(bad))
  }
  // The sign rule that mirrored east and west cannot be stated in this record.
  for (const rule of [1, 0, '2', null]) assert(errorsOf({ ...base, convention: rule }).some((m) => m.includes('convention must be 2')), String(rule))
  assert(errorsOf({ ...base, datum: 'NAD83' }).some((m) => m.includes("'WGS84'")))
  assert(errorsOf({ ...base, source: 'compass' }).some((m) => m.includes('georeference.source must be one of')))
  assert(errorsOf({ ...base, source: undefined }).some((m) => m.includes('georeference.source must be one of')))
})

test('validateGeoreference: declination, seed, times and the frame it was made against', () => {
  const base = seed()
  ok(base)
  ok(set(base, 'declination', undefined))
  for (const bad of [{ deg: 1.2, model: 'WMM2030', year: 2026.88 }, { deg: 91, model: 'WMM2025', year: 2026 }, { deg: 1, model: 'WMM2025' }, { deg: 1, model: 'WMM2025', year: 2026, extra: 1 }, null, 'east']) {
    assert(errorsOf({ ...base, declination: bad }).some((m) => m.startsWith('georeference.declination must be')), JSON.stringify(bad))
  }
  // The seed is audit data: plain JSON, bounded.
  assert(errorsOf({ ...base, seed: 'x' }).some((m) => m.includes('seed')))
  assert(errorsOf({ ...base, seed: { s: 'x'.repeat(501) } }).some((m) => m.includes('too long')))
  assert(errorsOf({ ...base, seed: { a: { b: { c: { d: { e: 1 } } } } } }).some((m) => m.includes('nested too deeply')))
  assert(errorsOf({ ...base, seed: { n: Number.NaN } }).some((m) => m.includes('finite')))
  assert(errorsOf({ ...base, seed: JSON.parse('{"constructor":{"x":1}}') }).some((m) => m.includes('will not store')))
  assert(errorsOf({ ...base, seed: Array.from({ length: 70 }, (_, i) => i) }).some((m) => m.includes('seed')), 'an array is not an object')
  assert(errorsOf({ ...base, seed: Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`k${i}`, i])) }).some((m) => m.includes('too many')))
  // Times are ISO times as `toISOString` writes them.
  for (const bad of ['2026-11-17', '1', 1_700_000_000_000, '', null, undefined, '2026-13-45T10:00:00.000Z']) {
    assert(errorsOf({ ...base, registeredAt: bad }).some((m) => m.includes('registeredAt')), String(bad))
  }
  assert(errorsOf({ ...mapClick(), confirmedAt: '2026-11-17' }).some((m) => m.includes('confirmedAt must be an ISO date')))
  assert(errorsOf({ ...mapClick(), confirmedAt: '2030-01-01T00:00:00.000Z' }).some((m) => m.includes('in the future')))
  ok({ ...mapClick(), confirmedAt: new Date(NOW + 60_000).toISOString() })
  // The frame it was made against: an id that can be a path segment, or null.
  for (const good of [null, 'frame-1', 'a'.repeat(64), '7f9c0c5e-1d52-4ab9-9e1d-2f6c1a1c11aa']) ok({ ...base, anchorRef: good })
  for (const bad of ['', 'a/b', 'a.b', 'a'.repeat(65), 7, undefined, '../x']) {
    assert(errorsOf({ ...base, anchorRef: bad }).some((m) => m.includes('anchorRef')), String(bad))
  }
})

test('validateGeoreference: every reason is reported, not only the first', () => {
  const errors = errorsOf({ ...mapClick(), bearingDeg: 400, convention: 1, origin: { lat: 99, lng: 0, altitudeM: null, accuracyM: 1 } })
  assert(errors.length >= 4, errors.join(' | '))
  assert(errors.some((m) => m.includes('origin.lat')))
  assert(errors.some((m) => m.includes('origin.accuracyM is below')))
  assert(errors.some((m) => m.includes('bearingDeg')))
  assert(errors.some((m) => m.includes('convention')))
})

test('validateGeoreference: a body of a hundred thousand wrong fields is answered in a few lines, with how many more there were', () => {
  const hostile: Record<string, unknown> = { ...mapClick() }
  for (let i = 0; i < 100_000; i++) hostile[`k${i}`] = 0
  const check = validateGeoreference(hostile, { now: NOW })
  assert(!check.ok)
  assertEquals(check.errors.length, MAX_REPORTED_PROBLEMS + 1)
  assertEquals(check.errors.at(-1), 'and 99980 more problems')
  assertEquals(check.error, check.errors[0])
  assert(JSON.stringify(check.errors).length < 2_000, 'the answer is a few lines, not a few megabytes')
  // At the limit nothing is cut: twenty problems are twenty lines.
  const exactly: Record<string, unknown> = { ...mapClick() }
  for (let i = 0; i < MAX_REPORTED_PROBLEMS; i++) exactly[`k${i}`] = 0
  const listed = validateGeoreference(exactly, { now: NOW })
  assert(!listed.ok)
  assertEquals(listed.errors.length, MAX_REPORTED_PROBLEMS)
  assert(!listed.errors.some((m) => m.startsWith('and ')))
})

test('readStoredGeoreference: a stored record that claims less error than today\'s floors is held to them and kept, and one that is not well formed is refused', () => {
  const stored = mapClick({ origin: { lat: 51.5007, lng: -0.1246, altitudeM: null, accuracyM: 3.5 }, bearingAccuracyDeg: 1 })
  // Today's floors: stored as it is, the same object.
  const now = readStoredGeoreference(stored)
  assert(now.ok)
  assert(now.georeference === holdToFloors(now.georeference))
  assertEquals(now.georeference, stored)
  // A floor a measurement raises later (the map-click floor 3.5 m to 5 m, 1 degree to 2): the writer would now refuse the record, and the
  // reader does not forget it. It claims what a record written today could.
  const floor = ACCURACY_FLOORS['map-click'] as { originM: number; bearingDeg: number }
  const was = { ...floor }
  try {
    floor.originM = 5
    floor.bearingDeg = 2
    assert(!validateGeoreference(stored, { now: NOW }).ok, 'a write is refused')
    const kept = readStoredGeoreference(stored)
    assert(kept.ok, 'a read keeps it')
    assertEquals([kept.georeference.origin.accuracyM, kept.georeference.bearingAccuracyDeg], [5, 2], 'held to the floors: never a better claim than they allow')
    assertEquals([kept.georeference.origin.lat, kept.georeference.origin.lng, kept.georeference.bearingDeg], [51.5007, -0.1246, stored.bearingDeg], 'and nothing else moves')
    // A record already over its floors is not touched.
    const worse = mapClick({ origin: { lat: 51.5007, lng: -0.1246, altitudeM: null, accuracyM: 12 }, bearingAccuracyDeg: 9 })
    const same = readStoredGeoreference(worse)
    assert(same.ok)
    assertEquals(same.georeference, worse)
  } finally {
    floor.originM = was.originM
    floor.bearingDeg = was.bearingDeg
  }
  // Not well formed is refused whatever the floors: the registry is a file a person can edit.
  for (const bad of [null, [], 'x', { ...stored, bearingDeg: 400 }, { ...stored, source: 'psychic' }, { ...stored, origin: { ...stored.origin, lat: 95 } }, { ...stored, origin: { ...stored.origin, accuracyM: 0 } }, { ...stored, extra: 1 }]) {
    assert(!readStoredGeoreference(bad).ok, JSON.stringify(bad))
  }
  assert(!validateGeoreference({ ...stored, origin: { ...stored.origin, accuracyM: 1 } }, { now: NOW }).ok, 'a write still enforces the floors')
  assert(validateGeoreference({ ...stored, origin: { ...stored.origin, accuracyM: 1 } }, { now: NOW, floors: false }).ok, 'unless asked not to')
})

test('inPlaceFrame: the tier a stored frame can have, the one the Place\'s frame was made with, and the generation it holds now when both are known', () => {
  assertEquals(inPlaceFrame('two-point-ground', 'two-point-ground'), true)
  assertEquals(inPlaceFrame('two-point-ground', 'ground-tap-compass'), false, 'another tier is another frame')
  assertEquals(inPlaceFrame('ground-tap-compass', null), true, 'a Place with no frame has nothing to differ from')
  assertEquals(inPlaceFrame('known-distance', null), false, 'a known-distance matrix is the camera solve\'s own coordinates')
  assertEquals(inPlaceFrame(undefined, null), false)
  // Generations: known on both sides and different is another frame; unknown on either side says nothing.
  assertEquals(inPlaceFrame('two-point-ground', 'two-point-ground', { scan: 'frame-a', place: 'frame-a' }), true)
  assertEquals(inPlaceFrame('two-point-ground', 'two-point-ground', { scan: 'frame-old', place: 'frame-a' }), false)
  assertEquals(inPlaceFrame('two-point-ground', 'two-point-ground', { scan: 'frame-old', place: null }), true)
  assertEquals(inPlaceFrame('two-point-ground', 'two-point-ground', { scan: undefined, place: 'frame-a' }), true)
  assertEquals(inPlaceFrame('two-point-ground', null, { scan: 'frame-old', place: 'frame-a' }), false, 'a generation differs even with no tier to compare')
  assertEquals(inPlaceFrame('two-point-ground', 'two-point-ground', {}), true)
})

test('placeFrameToScene: Ry(180 - bearing) and no move, and the same for the scans the placement carries', () => {
  for (const bearing of [0, 90, 180, 270]) {
    const m = placeFrameToScene({ bearingDeg: bearing })
    assertEquals(m.length, 16)
    assertEquals([m[12], m[13], m[14]], [0, 0, 0])
    assert(m.every((n) => !Object.is(n, -0)))
  }
  assertEquals(placeFrameToScene({ bearingDeg: 180 }), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  assertEquals(placeFrameToSceneFor(null, { calibrationMethod: 'two-point-ground' }, { method: 'two-point-ground' }), null)
  assertEquals(placeFrameToSceneFor({ bearingDeg: 90 }, { calibrationMethod: 'two-point-ground' }, { method: 'two-point-ground' }), placeFrameToScene({ bearingDeg: 90 }))
  assertEquals(placeFrameToSceneFor({ bearingDeg: 90 }, { calibrationMethod: 'ground-tap-compass' }, { method: 'two-point-ground' }), null)
})

test('validateGeoreference: a seed is not confirmed by being a seed, and a confirmation is a time', () => {
  const unconfirmed = ok(seed())
  assertEquals(isConfirmedGeoreference(unconfirmed), false)
  assertEquals(Object.hasOwn(unconfirmed, 'confirmedAt'), false, 'no confirmedAt is invented')
  assertEquals(isConfirmedGeoreference(ok(seed({ confirmedAt: '2026-11-17T11:00:00.000Z' }))), true)
  assertEquals(isConfirmedGeoreference(null), false)
  assertEquals(isConfirmedGeoreference({ confirmedAt: '' }), false)
})

test('sameGeoreference, versions and the frame a record was made against', () => {
  const a = mapClick()
  const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(a).reverse())))
  assert(sameGeoreference(a, reordered), 'key order is not a difference')
  assert(!sameGeoreference(a, mapClick({ bearingDeg: 30.001 })))
  assert(!sameGeoreference(a, null))
  assertEquals([undefined, null, {}, { georefVersion: 0 }, { georefVersion: -1 }, { georefVersion: 1.5 }, { georefVersion: '2' }].map((p) => placeGeorefVersion(p as never)), [0, 0, 0, 0, 0, 0, 0])
  assertEquals(placeGeorefVersion({ georefVersion: 3 }), 3)
  assertEquals([0, 1, 40].map(isGeorefVersion), [true, true, true])
  assertEquals([-1, 1.5, '1', null, Number.NaN].map(isGeorefVersion), [false, false, false, false, false])

  assertEquals(georeferenceFrameState(mapClick({ anchorRef: 'f1' }), { frameId: 'f1' }), 'matches')
  assertEquals(georeferenceFrameState(mapClick({ anchorRef: 'f1' }), { frameId: 'f2' }), 'other-frame')
  assertEquals(georeferenceFrameState(mapClick({ anchorRef: null }), { frameId: 'f2' }), 'unknown', 'a record made without a frame id says nothing')
  assertEquals(georeferenceFrameState(mapClick({ anchorRef: 'f1' }), {}), 'unknown', 'a frame written before ids existed says nothing')
  assertEquals(georeferenceFrameState(mapClick({ anchorRef: 'f1' }), null), 'unknown')
  assertEquals(georeferenceFrameState(null, { frameId: 'f1' }), 'unknown')
})

// ── bearingFromClicks and the error of a bearing ─────────────────────────────

test('bearingFromClicks: the angle on the ellipsoid, for every bearing and at every latitude, to a nanodegree', () => {
  let worst = 0
  for (const lat of [-60, -33.86, -0.18, 0.5, 37.77, 51.5, 64.1, 69.6]) {
    for (let bearing = 0; bearing < 360; bearing += 7.5) {
      const rad = (bearing * Math.PI) / 180
      for (const metres of [1.5, 30, 250]) {
        const from = { lat, lng: 12.3 }
        const to = enuToGeodetic({ ...from, altitudeM: 0 }, { east: metres * Math.sin(rad), north: metres * Math.cos(rad), up: 0 })
        const got = bearingFromClicks(from, { lat: to.lat, lng: to.lng })!
        worst = Math.max(worst, Math.abs(angDiff(got, bearing)))
        assertAlmostEquals(baselineLengthM(from, { lat: to.lat, lng: to.lng })!, metres, 1e-6)
      }
    }
  }
  assert(worst < 1e-6, `worst error ${worst} degrees`)
  // The cardinal directions are exactly those.
  assertAlmostEquals(bearingFromClicks({ lat: 51.5, lng: 0 }, { lat: 51.6, lng: 0 })!, 0, 1e-9)
  // A point on the same parallel is a hair north of due east from the start (a parallel curves away from the straight line),
  // by 0.0004 degrees at 700 m here: the tolerance is that, and the exact east offset is checked to a nanodegree above.
  assertAlmostEquals(bearingFromClicks({ lat: 51.5, lng: 0 }, { lat: 51.5, lng: 0.01 })!, 90, 0.01)
  assertAlmostEquals(bearingFromClicks({ lat: 51.5, lng: 0 }, { lat: 51.4, lng: 0 })!, 180, 1e-9)
  assertAlmostEquals(bearingFromClicks({ lat: 51.5, lng: 0 }, { lat: 51.5, lng: -0.01 })!, 270, 0.01)
  // Across the antimeridian it is still east.
  assertAlmostEquals(bearingFromClicks({ lat: -16.5, lng: 179.9999 }, { lat: -16.5, lng: -179.9999 })!, 90, 0.01)
})

test('bearingFromClicks: the planar shortcut on latitude and longitude is off by degrees at 60 degrees north, and this is not it', () => {
  // 100 m east and 100 m north at 60 N is 45 degrees. A degree of longitude is half as long there, so atan2(dLng, dLat) says 63.
  const from = { lat: 60, lng: 10 }
  const to = enuToGeodetic({ ...from, altitudeM: 0 }, { east: 100, north: 100, up: 0 })
  const planar = (Math.atan2(to.lng - from.lng, to.lat - from.lat) * 180) / Math.PI
  assert(Math.abs(planar - 45) > 15, `the planar bearing is ${planar}`)
  assertAlmostEquals(bearingFromClicks(from, { lat: to.lat, lng: to.lng })!, 45, 1e-6)
})

test('bearingFromClicks: no bearing from one point, or from a position that is not one', () => {
  assertEquals(bearingFromClicks({ lat: 51.5, lng: 0 }, { lat: 51.5, lng: 0 }), null)
  assertEquals(bearingFromClicks({ lat: Number.NaN, lng: 0 }, { lat: 51.5, lng: 0 }), null)
  assertEquals(bearingFromClicks({ lat: 51.5, lng: 0 }, { lat: 90, lng: 0 }), null)
  assertEquals(baselineLengthM({ lat: 51.5, lng: 0 }, { lat: 51.5, lng: Number.POSITIVE_INFINITY }), null)
})

test('predictedBearingSigmaDeg: R6 table 6.3 (sqrt(2) x click sigma / baseline), with the floors of each kind of baseline', () => {
  // [baseline m, click sigma m, the table's degrees]. The table is the unfloored formula.
  const table: Array<[number, number, number]> = [
    [1, 0.1, 8.1], [1, 0.3, 24.31], [2, 0.1, 4.05], [2, 0.3, 12.15], [3, 0.1, 2.7], [3, 0.3, 8.1], [3, 0.5, 13.5],
    [5, 0.3, 4.86], [5, 0.5, 8.1], [10, 0.3, 2.43], [10, 0.5, 4.05], [20, 0.3, 1.22], [30, 0.3, 0.81], [50, 0.5, 0.81],
  ]
  for (const [baseline, click, degrees] of table) {
    const got = predictedBearingSigmaDeg(baseline, click)!
    const floor = baseline >= 10 ? 1 : 8
    assertAlmostEquals(got, Math.max(degrees, floor), 0.01, `${baseline} m at ${click} m`)
  }
  // The default click noise is 0.3 m, and a 1-3 m landmark-to-marker pair gives 8 to 24 degrees (R6: 5.7 to 17 at its one-end figure).
  assertAlmostEquals(predictedBearingSigmaDeg(1)!, 24.31, 0.01)
  assertAlmostEquals(predictedBearingSigmaDeg(3)!, 8.1, 0.01)
  // A long edge cannot be claimed better than a degree, and a short baseline cannot be claimed better than 8.
  assertEquals(predictedBearingSigmaDeg(50, 0.1), 1)
  assertEquals(predictedBearingSigmaDeg(9.99, 0.01), 8)
  assertEquals(predictedBearingSigmaDeg(10, 0.01), 1)
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertEquals(predictedBearingSigmaDeg(bad), null)
    assertEquals(predictedBearingSigmaDeg(10, bad), null)
  }
})

test('accuracyAt: the origin at 0, and the lateral error of a bearing sigma at r (R6 table 6.3)', () => {
  const g = { origin: { accuracyM: 3.5 }, bearingAccuracyDeg: 1 }
  assertEquals(accuracyAt(g, 0), 3.5)
  // At r = 20 m: 0.5 deg is 0.17 m, 1 deg 0.35 m, 2 deg 0.70, 5 deg 1.74, 10 deg 3.47, 15 deg 5.18, 23 deg 7.81 (before the
  // origin's term). The table is the chord, 20 sin(angle); the rule is the small-angle form, r times the angle in radians,
  // which R6 calls an approximation good to about 7%: the same to the hundredth up to 2 degrees, and within 3% at 23.
  for (const [deg, lateral] of [[0.5, 0.17], [1, 0.35], [2, 0.7], [5, 1.74], [10, 3.47], [15, 5.18], [23, 7.81]] as const) {
    const withoutOrigin = accuracyAt({ origin: { accuracyM: 1e-9 }, bearingAccuracyDeg: deg }, 20)!
    assertAlmostEquals(withoutOrigin, 20 * deg * (Math.PI / 180), 1e-6, `${deg} degrees at 20 m: r times the angle`)
    assert(Math.abs(withoutOrigin - lateral) / lateral < 0.07, `${deg} degrees at 20 m is within 7% of the table`)
    if (deg <= 2) assertAlmostEquals(withoutOrigin, lateral, 0.01)
  }
  assertAlmostEquals(accuracyAt(g, 20)!, Math.hypot(3.5, 20 * (Math.PI / 180)), 1e-12)
  assertEquals(accuracyAt(g, -20), accuracyAt(g, 20), 'a distance has no sign')
  assertEquals(accuracyAt(g, Number.NaN), null)
  assert(accuracyAt(g, 50)! > accuracyAt(g, 10)!, 'farther is less sure')
})

// ── From a session's compass to the Place bearing ────────────────────────────

const PSI = Array.from({ length: 24 }, (_, i) => i * 15)
const TURNS = [-180, -90, -45, 0, 30, 90, 150]
const DOWN = [0, 25, 60]

test('projectBearingFromSession: the true bearing of a two-point frame, from any session, to 1e-9 degrees', () => {
  // A physical model shares no code with the app. A session starts facing `psi`, the camera turns and tilts, the
  // compass is perfect (true north), and the Place frame is made from two taps in the session.
  const landmarkAt: Enu = { east: 1.5, north: -2, up: 0 }
  let worst = 0
  let n = 0
  for (const baseline of [0, 33, 90, 137, 180, 252, 301]) {
    const b = (baseline * Math.PI) / 180
    const markerAt: Enu = { east: landmarkAt.east + 2.4 * Math.sin(b), north: landmarkAt.north + 2.4 * Math.cos(b), up: 0 }
    const truth = bearingOfEnu({ east: markerAt.east - landmarkAt.east, north: markerAt.north - landmarkAt.north })
    for (const psi of PSI) {
      const landmark: V3 = enuToSession(psi, landmarkAt)
      const marker: V3 = enuToSession(psi, markerAt)
      const sessionToProject = twoPointToProjectTransform(landmark, marker)
      for (const turn of TURNS) {
        for (const down of DOWN) {
          const rotation = cameraRotation(turn, down)
          const sessionBearing = sessionFrameBearingDeg(perfectCompassBearing(psi, rotation), rotation)!
          const got = projectBearingFromSession(sessionBearing, sessionToProject)!
          worst = Math.max(worst, Math.abs(angDiff(got, truth)))
          assert(got >= 0 && got < 360)
          n++
        }
      }
    }
  }
  assert(worst < 1e-9, `worst error ${worst} degrees over ${n} cases`)
  // The same through the baseline formula of the research, b = B_Z - atan2(H.x - L.x, H.z - L.z): this is that, through the matrix.
  const landmark = { x: 0.3, y: 0, z: -1.2 }
  const marker = { x: 2.1, y: 0, z: 0.4 }
  assertAlmostEquals(
    projectBearingFromSession(123, twoPointToProjectTransform(landmark, marker))!,
    ((123 - twoPointHeadingDeg(landmark, marker)) % 360 + 360) % 360,
    1e-12,
  )
})

test('projectBearingFromSession: a one-point frame has its +Z at the compass north, so a perfect compass gives bearing 0', () => {
  for (const psi of [0, 77, 200]) {
    const rotation = cameraRotation(-60, 25)
    const frameBearing = sessionFrameBearingDeg(perfectCompassBearing(psi, rotation), rotation)
    assertAlmostEquals(frameBearing!, trueSessionZBearing(psi), 1e-9)
    const m = oneTapToProjectTransform({ x: 0.3, y: -0.4, z: -1.2 }, frameBearing)!
    assertAlmostEquals(angDiff(projectBearingFromSession(frameBearing!, m)!, 0), 0, 1e-9, `psi ${psi}`)
  }
})

test('projectBearingFromSession: nothing to say from a bearing or a matrix that is not one', () => {
  const m = twoPointToProjectTransform({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 2 })
  assertEquals(projectBearingFromSession(Number.NaN, m), null)
  assertEquals(projectBearingFromSession(10, m.slice(0, 15)), null)
  assertEquals(projectBearingFromSession(10, new Array(16).fill(0)), null, 'a matrix with no yaw has no bearing')
  assertEquals(projectBearingFromSession(10, [...m.slice(0, 2), Number.NaN, ...m.slice(3)]), null)
})

test('frameOffsetToEnu: R6 T8, and its own inverse', () => {
  const b30 = frameOffsetToEnu(30, 2, 5)
  assertAlmostEquals(b30.east, 0.76794919, 1e-8)
  assertAlmostEquals(b30.north, 5.33012702, 1e-8)
  const b0z = frameOffsetToEnu(0, 0, 1)
  assertAlmostEquals(b0z.east, 0, 1e-15)
  assertAlmostEquals(b0z.north, 1, 1e-15)
  const b0x = frameOffsetToEnu(0, 1, 0)
  assertAlmostEquals(b0x.east, -1, 1e-15)
  assertAlmostEquals(b0x.north, 0, 1e-15)
  const b180x = frameOffsetToEnu(180, 1, 0)
  assertAlmostEquals(b180x.east, 1, 1e-15)
  assertAlmostEquals(b180x.north, 0, 1e-15)
  const b180z = frameOffsetToEnu(180, 0, 1)
  assertAlmostEquals(b180z.east, 0, 1e-15)
  assertAlmostEquals(b180z.north, -1, 1e-15)
  // The inverse (x = -E cos b + N sin b, z = E sin b + N cos b) recovers the point.
  for (const bearing of [0, 30, 117, 200, 359]) {
    const b = (bearing * Math.PI) / 180
    const { east, north } = frameOffsetToEnu(bearing, 2, 5)
    assertAlmostEquals(-east * Math.cos(b) + north * Math.sin(b), 2, 1e-12)
    assertAlmostEquals(east * Math.sin(b) + north * Math.cos(b), 5, 1e-12)
  }
})

// ── GeoPose ──────────────────────────────────────────────────────────────────

/** The fields GeoPose.Basic.Quaternion requires: https://schemas.opengis.net/geopose/1.0/schemata/ (Basic.Quaternion, 2025-04-09, as R6 section 5.1 recorded it). */
const BASIC_QUATERNION_REQUIRED = { position: ['lat', 'lon', 'h'], quaternion: ['x', 'y', 'z', 'w'] } as const

test('toGeoPoseBasicQuaternion: the quaternions of R6 T11, and a pose valid against the Basic-Quaternion schema', () => {
  // [bearing of Place +Z, x, y, z, w]
  const vectors: Array<[number, number, number, number]> = [
    [180, 0, 0, 1],
    [90, 0, 0.7071067811865475, 0.7071067811865476],
    [0, 0, 1, 6.123233995736766e-17],
    [270, 0, -0.7071067811865475, 0.7071067811865476],
    [30, 0, 0.9659258262890683, 0.25881904510252074],
  ]
  for (const [bearing, x, z, w] of vectors.map(([b, x, z, w]) => [b, x, z, w] as const)) {
    const q = toGeoPoseBasicQuaternion(mapClick({ bearingDeg: bearing })).geopose.quaternion
    assertEquals(q.x, x)
    assertEquals(q.y, 0)
    assertAlmostEquals(q.z, z, 1e-15, `b ${bearing}: z`)
    assertAlmostEquals(q.w, w, 1e-15, `b ${bearing}: w`)
    assertAlmostEquals(Math.hypot(q.x, q.y, q.z, q.w), 1, 1e-12, 'unit length')
  }
  const sample = toGeoPoseBasicQuaternion(mapClick({ origin: { lat: 51.5007, lng: -0.1246, altitudeM: 11, accuracyM: 3.5 }, heightDatum: 'ellipsoid', bearingDeg: 30 }))
  // R6 section 5.3's London example: b = 30, h assumed 11.
  assertEquals(sample.geopose, {
    position: { lat: 51.5007, lon: -0.1246, h: 11 },
    quaternion: { x: 0, y: 0, z: 0.9659258262890683, w: 0.25881904510252074 },
  })
  // Valid against GeoPose.Basic.Quaternion: every required field, each a finite number; and against the strict variant
  // (additionalProperties false), because nothing else is in the pose: the accuracy and provenance are beside it.
  for (const [group, fields] of Object.entries(BASIC_QUATERNION_REQUIRED)) {
    const object = sample.geopose[group as keyof typeof sample.geopose] as Record<string, unknown>
    for (const field of fields) assert(typeof object[field] === 'number' && Number.isFinite(object[field] as number), `${group}.${field}`)
    assertEquals(Object.keys(object).sort(), [...fields].sort(), `${group} has no field the strict schema would refuse`)
  }
  assertEquals(Object.keys(sample.geopose).sort(), ['position', 'quaternion'])
  assertEquals(sample.meta.horizontalM68, 3.5)
  assertEquals(sample.meta.bearingDeg1sigma, 1)
  assertEquals(sample.meta.source, 'map-click')
  assertEquals(sample.meta.hSource, 'ellipsoid')
  assertEquals(sample.meta.confirmed, true)
  assertEquals(sample.meta.objectFrame, GEOPOSE_OBJECT_FRAME)
})

test('toGeoPoseBasicQuaternion: h is the ellipsoidal height or a flagged 0, a longitude is wrapped, and a seed is not confirmed', () => {
  const noHeight = toGeoPoseBasicQuaternion(mapClick())
  assertEquals(noHeight.geopose.position.h, 0)
  assertEquals(noHeight.meta.hSource, 'nominal', 'a height nobody knows is flagged, not exported as a measurement')
  const heights = toGeoPoseBasicQuaternion(mapClick({ origin: { lat: 51.5, lng: 1, altitudeM: -3.25, accuracyM: 3.5 }, heightDatum: 'ellipsoid' }))
  assertEquals(heights.geopose.position.h, -3.25)
  // A height whose datum is not known is not exported as an ellipsoidal one (a phone's coords.altitude is above mean sea level on an iPhone).
  const unknownDatum = toGeoPoseBasicQuaternion(mapClick({ origin: { lat: 51.5, lng: 1, altitudeM: 41.2, accuracyM: 3.5 }, heightDatum: 'unknown' }))
  assertEquals(unknownDatum.geopose.position.h, 0)
  assertEquals(unknownDatum.meta.hSource, 'nominal')
  assertEquals(toGeoPoseBasicQuaternion(seed()).meta.confirmed, false)
  assertEquals(wrapLongitudeDeg(190), -170)
  assertEquals(wrapLongitudeDeg(-190), 170)
  assertEquals(wrapLongitudeDeg(0), 0)
  assertEquals(wrapLongitudeDeg(179.5), 179.5)
  assertEquals(toGeoPoseBasicQuaternion(mapClick({ origin: { lat: -16.5, lng: -179.9999, altitudeM: null, accuracyM: 3.5 } })).geopose.position.lon, -179.9999)
})

test('toGeoPoseBasicQuaternion: the quaternion turns plain ENU into the Place frame, the way the Place frame lies on the ground', () => {
  // Identity is plain ENU. Object X, Y, Z are the Place's +X, -Z (forward) and +Y (up), so for every bearing the quaternion
  // must carry east, north and up onto exactly those three directions, which the physical model gives as east/north
  // offsets of a right-handed frame whose +Z has bearing b (R6 section 2).
  let worst = 0
  for (let bearing = 0; bearing < 360; bearing += 5) {
    const q = toGeoPoseBasicQuaternion(mapClick({ bearingDeg: bearing })).geopose.quaternion
    const east = rotateByQuat(q, { x: 1, y: 0, z: 0 })
    const north = rotateByQuat(q, { x: 0, y: 1, z: 0 })
    const up = rotateByQuat(q, { x: 0, y: 0, z: 1 })
    const placeX = frameOffsetToEnu(bearing, 1, 0)
    const placeMinusZ = frameOffsetToEnu(bearing, 0, -1)
    worst = Math.max(
      worst,
      Math.hypot(east.x - placeX.east, east.y - placeX.north, east.z),
      Math.hypot(north.x - placeMinusZ.east, north.y - placeMinusZ.north, north.z),
      Math.hypot(up.x, up.y, up.z - 1),
    )
  }
  assert(worst < 1e-12, `worst ${worst}`)
  // And the sign is the right one on a single case a reader can check: with the Place +Z at bearing 90 (east), the object's
  // forward Y points west (bearing 270), and its X points north.
  const q = toGeoPoseBasicQuaternion(mapClick({ bearingDeg: 90 })).geopose.quaternion
  const forward = rotateByQuat(q, { x: 0, y: 1, z: 0 })
  assertAlmostEquals(forward.x, -1, 1e-12)
  assertAlmostEquals(forward.y, 0, 1e-12)
  const x = rotateByQuat(q, { x: 1, y: 0, z: 0 })
  assertAlmostEquals(x.x, 0, 1e-12)
  assertAlmostEquals(x.y, 1, 1e-12)
})

// ── The block an export carries ──────────────────────────────────────────────

test('georeferenceBlock and georeferenceOriginAsGeoPose: the record as an export and a world carry it, and null is explicit', () => {
  assertEquals(georeferenceBlock(null, 0), null)
  assertEquals(georeferenceBlock(undefined, 4), null)
  const block = georeferenceBlock(mapClick({ origin: { lat: 51.5007, lng: -0.1246, altitudeM: 11, accuracyM: 3.5 }, heightDatum: 'ellipsoid' }), 3)!
  assertEquals(block, {
    crs: 'WGS84',
    origin: { lat: 51.5007, lng: -0.1246, altitudeM: 11 },
    heightDatum: 'ellipsoid',
    bearingDeg: 30,
    convention: block.convention,
    accuracy: { positionM: 3.5, bearingDeg: 1 },
    source: 'map-click',
    confirmedAt: '2026-11-17T10:00:00.000Z',
    georefVersion: 3,
    anchorRef: 'frame-1',
  })
  assert(block.convention.includes('x east, y up, z south'), 'the convention says what the scene is')
  assert(block.convention.includes('true bearing') && block.convention.includes('+Z'), 'and what the bearing is the bearing of')
  assertEquals(georeferenceBlock(seed(), 1)!.confirmedAt, null, 'a seed nobody confirmed says so')

  const pose = georeferenceOriginAsGeoPose(mapClick())
  assertEquals(pose, { lat: 51.5007, lng: -0.1246, altitudeM: null, bearing: null, accuracyM: 3.5, fixedAt: '2026-11-17T10:00:00.000Z' })
})

// ── Seeds ────────────────────────────────────────────────────────────────────

test('circularStats: a mean of 359 and 1 is 0, a spread is a circular one, and nothing cancels into a bearing', () => {
  assertAlmostEquals(circularStats([359, 1])!.meanDeg, 0, 1e-9)
  assertAlmostEquals(circularStats([350, 10])!.meanDeg, 0, 1e-9)
  assertAlmostEquals(circularStats([10, 20, 30])!.meanDeg, 20, 1e-9)
  assertAlmostEquals(circularStats([90, 270, 90, 270, 90])!.meanDeg, 90, 1e-9)
  // The circular SD of a small spread is the ordinary SD: 1 and -1 degrees around 0 is about 1 degree.
  assertAlmostEquals(circularStats([1, -1])!.sdDeg, 1, 0.001)
  assertAlmostEquals(circularStats([-10, 10, -10, 10])!.sdDeg, 10, 0.05)
  assert(Object.is(circularStats([42, 42, 42])!.sdDeg, 0), 'identical angles have a spread of exactly 0, never -0')
  assertEquals(circularStats([42])!.count, 1)
  // Opposite angles cancel: there is no mean direction, and the spread is infinite.
  const opposite = circularStats([0, 180])!
  assertEquals(opposite.sdDeg, Infinity)
  assertAlmostEquals(opposite.resultant, 0, 1e-12)
  assertEquals(circularStats([]), null)
  assertEquals(circularStats([1, Number.NaN]), null)
  assertEquals(circularStats([1, Number.POSITIVE_INFINITY]), null)
})

/** `n` samples `dt` seconds apart, all reading `bearing` plus `noise(i)`. */
function samples(n: number, dt: number, bearing: number, noise: (i: number) => number = () => 0, rate: number | null = 2): BearingSample[] {
  return Array.from({ length: n }, (_, i) => ({ tS: i * dt, bearingDeg: bearing + noise(i), rateDegS: rate }))
}

test('bearingSeedFromSamples: steady samples only, enough of them over enough time, with the floor under the sigma', () => {
  const eight = samples(8, 0.3, 200)
  const seedA = bearingSeedFromSamples(eight)!
  assertAlmostEquals(seedA.bearingDeg, 200, 1e-9)
  assertEquals(seedA.samples, 8)
  assertAlmostEquals(seedA.spanS, 2.1, 1e-12)
  assert(Object.is(seedA.spreadDeg, 0))
  assertEquals(seedA.sigmaDeg, BEARING_SIGMA_FLOOR_SEED_DEG, 'no spread still claims 15 degrees, never 0')
  assertEquals(bearingSeedFromSamples(eight, BEARING_SIGMA_FLOOR_SEED_IOS_DEG)!.sigmaDeg, 25, 'an iPhone is held to 25 until DX3')

  // Too few, however well they agree.
  assertEquals(MIN_BEARING_SAMPLES, 8)
  assertEquals(bearingSeedFromSamples(samples(7, 0.5, 200)), null)
  // Too short a time, however many: 40 samples in 1.99 s.
  assertEquals(bearingSeedFromSamples(samples(40, 1.99 / 39, 200)), null)
  assert(bearingSeedFromSamples(samples(40, 2 / 39, 200)) !== null, 'exactly 2 s is enough')
  // A spread larger than the floor is the sigma: the circular SD of +-20 degrees around 200.
  const wide = bearingSeedFromSamples(samples(20, 0.2, 200, (i) => (i % 2 === 0 ? 20 : -20)))!
  assertAlmostEquals(wide.spreadDeg, 20.1, 0.2)
  assertEquals(wide.sigmaDeg, wide.spreadDeg)
  // Across north: a mean of 355 and 5 is north.
  assertAlmostEquals(bearingSeedFromSamples(samples(20, 0.2, 0, (i) => (i % 2 === 0 ? 5 : -5)))!.bearingDeg, 0, 1e-9)

  // A sample taken while the phone was turning fast is not steady, and neither is one with no rate to judge by.
  const mixed: BearingSample[] = [
    ...samples(8, 0.3, 90),
    { tS: 3, bearingDeg: 270, rateDegS: 45 },
    { tS: 3.1, bearingDeg: 270, rateDegS: 10 },
    { tS: 3.2, bearingDeg: 270, rateDegS: null },
    { tS: 3.3, bearingDeg: 270, rateDegS: Number.NaN },
  ]
  const steady = bearingSeedFromSamples(mixed)!
  assertEquals(steady.samples, 8, 'a rate of exactly 10 is not below 10')
  assertAlmostEquals(steady.bearingDeg, 90, 1e-9)
  // The ones that fail the rule are not "almost": remove the steady ones and nothing is left.
  assertEquals(bearingSeedFromSamples(mixed.slice(8)), null)
  // A reading that is not a number, or a time that is not, is dropped.
  assertEquals(bearingSeedFromSamples([...samples(7, 0.5, 90), { tS: 4, bearingDeg: Number.NaN, rateDegS: 1 }]), null)
  assertEquals(bearingSeedFromSamples([]), null)
})

test('BearingAccumulator: the list\'s seed one sample at a time, with the declination added at the end, and cleared between sessions', () => {
  const list = samples(20, 0.2, 200, (i) => (i % 2 === 0 ? 8 : -8))
  const accumulator = new BearingAccumulator()
  assertEquals(list.map((sample) => accumulator.add(sample)).every(Boolean), true, 'a steady sample says it was taken')
  assertEquals(accumulator.count, 20)
  assertEquals(accumulator.seed(), bearingSeedFromSamples(list), 'one at a time is the list')
  // A sample that is not steady is refused, says so, and is not counted.
  assertEquals(accumulator.add({ tS: 5, bearingDeg: 10, rateDegS: 45 }), false)
  assertEquals(accumulator.add({ tS: 5, bearingDeg: 10, rateDegS: null }), false)
  assertEquals(accumulator.count, 20)

  // Magnetic readings: the declination moves the mean and leaves the spread alone. East positive: true = magnetic + declination.
  const plain = accumulator.seed()!
  const shifted = accumulator.seed(BEARING_SIGMA_FLOOR_SEED_DEG, 12.5)!
  assertAlmostEquals(shifted.bearingDeg, plain.bearingDeg + 12.5, 1e-9)
  assertEquals(shifted.spreadDeg, plain.spreadDeg)
  assertEquals(shifted.sigmaDeg, plain.sigmaDeg)
  // The offset folds across north.
  const north = new BearingAccumulator()
  for (const sample of samples(10, 0.3, 355)) north.add(sample)
  assertAlmostEquals(north.seed(15, 10)!.bearingDeg, 5, 1e-9)
  assertAlmostEquals(north.seed(15, -370)!.bearingDeg, 345, 1e-9)

  // Sessions do not mix: clear() starts again from nothing.
  accumulator.clear()
  assertEquals(accumulator.count, 0)
  assertEquals(accumulator.seed(), null)
  // The next session starts later on the same clock: a time span that still began at the first session's would be 100 s long.
  for (const sample of samples(8, 0.3, 90)) accumulator.add({ ...sample, tS: sample.tS + 100 })
  assertAlmostEquals(accumulator.seed()!.bearingDeg, 90, 1e-9, 'nothing of the first session is left in it')
  assertAlmostEquals(accumulator.seed()!.spanS, 2.1, 1e-9, 'nor of its time span')

  // Samples that cancel give no bearing rather than an arbitrary one.
  const cancel = new BearingAccumulator()
  for (const sample of samples(10, 0.3, 0, (i) => (i % 2 === 0 ? 0 : 180))) cancel.add(sample)
  assertEquals(cancel.seed(), null)
})

test('bestFixInWindow: the best accuracy of the first 60 s, not a mean, and never one that is not usable', () => {
  const fix = (accuracyM: number, tS: number, extra: Partial<SeedFix> = {}): SeedFix => ({ lat: 51.5, lng: -0.12, accuracyM, altitudeM: null, tS, sessionX: null, sessionZ: null, ...extra })
  assertEquals(bestFixInWindow([fix(12, 5), fix(4, 40), fix(8, 2)]), fix(4, 40))
  assertEquals(bestFixInWindow([fix(6, 20), fix(6, 3), fix(6, 50)])!.tS, 3, 'equal accuracy: the earlier, which is nearer the session origin')
  // Out of the window, or not usable: dropped, and the next best is taken.
  assertEquals(bestFixInWindow([fix(2, 61), fix(9, 30)])!.accuracyM, 9, 'a fix after 60 s is not in the first minute')
  assertEquals(bestFixInWindow([fix(2, 60)])!.accuracyM, 2, 'a fix at exactly 60 s is')
  assertEquals(bestFixInWindow([fix(2, -1), fix(9, 30)])!.accuracyM, 9, 'and one before the walk began is not')
  assertEquals(bestFixInWindow([fix(0, 1), fix(-5, 1), fix(Number.NaN, 1), fix(50.1, 1), fix(Number.POSITIVE_INFINITY, 1)]), null, 'accuracy that is zero, negative, not a number or worse than 50 m')
  assertEquals(bestFixInWindow([fix(50, 1)])!.accuracyM, 50)
  assertEquals(bestFixInWindow([fix(5, 1, { lat: Number.NaN }), fix(5, 1, { lat: 91 }), fix(5, 1, { lng: Number.NaN })]), null)
  assertEquals(bestFixInWindow([]), null)
  // Averaging is not what it does: two fixes 30 m apart are one of them, not the midpoint.
  const a = fix(10, 1, { lat: 51.5 })
  const b = fix(11, 2, { lat: 51.5003 })
  assertEquals(bestFixInWindow([a, b])!.lat, 51.5)
})

test('seedOriginAccuracyM: max(reported, 10) when it is 10 or better, max(reported x 1.5, 25) when it is worse (R6 4.4 step 4)', () => {
  assertEquals(seedOriginAccuracyM(3), 10)
  assertEquals(seedOriginAccuracyM(10), 10)
  assertEquals(seedOriginAccuracyM(10.1), 25)
  assertEquals(seedOriginAccuracyM(20), 30)
  assertEquals(seedOriginAccuracyM(50), 75)
  assert(seedOriginAccuracyM(3) >= ORIGIN_ACCURACY_FLOOR_SEED_M, 'a seed always satisfies the floor of its own source')
  // So a record made from a seed's own numbers is a record the validator takes.
  for (const reported of [1, 5, 10, 12, 25, 50]) {
    ok(seed({ origin: { lat: 51.5, lng: -0.12, altitudeM: null, accuracyM: seedOriginAccuracyM(reported) } }))
  }
})

test('placeBearingSeed: the circular mean over scans, with a sigma no smaller than the largest floor, and low confidence said', () => {
  const e = (bearingDeg: number, sigmaFloorDeg = 15) => ({ bearingDeg, sigmaFloorDeg })
  const three = placeBearingSeed([e(28), e(33), e(30)])!
  assertAlmostEquals(three.bearingDeg, 30.333, 0.01, 'the circular mean of 28, 33 and 30')
  assertEquals(three.scans, 3)
  assertEquals(three.sigmaDeg, 15, 'a tight spread is not a small error: the floor holds')
  assertEquals(three.lowConfidence, false)
  assertEquals(placeBearingSeed([e(28), e(33)])!.lowConfidence, true, 'two scans are not enough')
  assertEquals(placeBearingSeed([e(10), e(40), e(70), e(100)])!.lowConfidence, true, 'a spread over 30 degrees')
  // One iPhone scan holds the whole seed to 25.
  assertEquals(placeBearingSeed([e(28), e(33), e(30, 25)])!.sigmaDeg, 25)
  // A mean across north.
  assertAlmostEquals(placeBearingSeed([e(358), e(2), e(0)])!.bearingDeg, 0, 1e-9)
  // A wide spread is the sigma, capped at 180.
  const wide = placeBearingSeed([e(0), e(120), e(240), e(10)])!
  assert(wide.sigmaDeg > 15 && wide.sigmaDeg <= 180)
  assertEquals(placeBearingSeed([e(0), e(180)])!.sigmaDeg, 180, 'opposite estimates know nothing')
  assertEquals(placeBearingSeed([]), null)
  assertEquals(placeBearingSeed([e(Number.NaN)]), null)
  assertEquals(placeBearingSeed([{ bearingDeg: 1, sigmaFloorDeg: Number.NaN }]), null)
  // The seed's numbers make a record the validator takes.
  ok(seed({ bearingDeg: three.bearingDeg, bearingAccuracyDeg: three.sigmaDeg }))
})

test('declinationRecord: WMM2025 at a place and a date, and nothing outside its years', () => {
  const when = new Date('2026-11-17T00:00:00Z')
  const london = declinationRecord(51.5007, -0.1246, when)!
  assertEquals(london.model, 'WMM2025')
  assertAlmostEquals(london.deg, 1.2, 0.3, 'R6: London +1.2 degrees at 2026.875')
  assertAlmostEquals(london.year, 2026.88, 0.01)
  assertAlmostEquals(declinationRecord(47.6, -122.3, when)!.deg, 14.9, 0.5, 'R6: Seattle +14.9')
  assertEquals(declinationRecord(51.5, -0.12, new Date('2031-01-01T00:00:00Z')), null, 'after the model ends: no value, never an extrapolation')
  assertEquals(declinationRecord(51.5, -0.12, new Date('2024-06-01T00:00:00Z')), null, 'before it starts')
  assertEquals(declinationRecord(95, 0, when), null)
  assertEquals(declinationRecord(Number.NaN, 0, when), null)
  assertEquals(declinationRecord(51.5, Number.NaN, when), null)
  assertEquals(declinationRecord(51.5, 0, new Date(Number.NaN)), null)
  // The record it makes is one a georeference can carry.
  ok(seed({ declination: london }))
})

// ── buildGeoreference ────────────────────────────────────────────────────────

test('buildGeoreference: a bearing already in range is stored exactly as given, with no float noise from folding it', () => {
  const now = new Date('2026-11-17T09:30:00.000Z')
  for (const bearingDeg of [41.3, 0, 0.1, 123.456789, 359.9999, 180]) {
    const record = buildGeoreference({ lat: 51.5, lng: -0.12, originAccuracyM: 3.5, bearingDeg, bearingAccuracyDeg: 1, source: 'typed', anchorRef: null, now, confirmed: false })
    assertEquals(record.bearingDeg, bearingDeg, `${bearingDeg} is stored as typed`)
  }
  // Out of range still folds, and 360 is north.
  const folded = [360, 720, -90, 450].map((bearingDeg) => buildGeoreference({ lat: 51.5, lng: -0.12, originAccuracyM: 3.5, bearingDeg, bearingAccuracyDeg: 1, source: 'typed', anchorRef: null, now, confirmed: false }).bearingDeg)
  assertEquals(folded, [0, 0, 270, 90])
})

test('buildGeoreference: a record from numbers, with the bearing folded, the datum read from the height, and confirmation only when asked', () => {
  const now = new Date('2026-11-17T09:30:00.123Z')
  const typed = buildGeoreference({ lat: 51.5, lng: -0.12, originAccuracyM: 3.5, bearingDeg: -10, bearingAccuracyDeg: 1, source: 'typed', anchorRef: null, now, confirmed: false })
  assertEquals(typed.bearingDeg, 350)
  assertEquals(typed.heightDatum, 'unknown')
  assertEquals(typed.origin.altitudeM, null)
  assertEquals(typed.registeredAt, '2026-11-17T09:30:00.123Z')
  assertEquals(Object.hasOwn(typed, 'confirmedAt'), false, 'building a record does not confirm it')
  assertEquals(Object.hasOwn(typed, 'declination'), false)
  assertEquals(Object.hasOwn(typed, 'seed'), false)
  ok(typed)

  const confirmed = buildGeoreference({ lat: 51.5, lng: -0.12, altitudeM: 12.5, originAccuracyM: 3.5, bearingDeg: 370, bearingAccuracyDeg: 1, source: 'map-click', anchorRef: 'f9', now, confirmed: true, declination: null, seed: null })
  assertEquals(confirmed.bearingDeg, 10)
  assertEquals(confirmed.heightDatum, 'ellipsoid')
  assertEquals(confirmed.confirmedAt, '2026-11-17T09:30:00.123Z')
  assertEquals(confirmed.anchorRef, 'f9')
  ok(confirmed)

  const withDeclination = buildGeoreference({
    lat: 51.5, lng: -0.12, originAccuracyM: 25, bearingDeg: 200, bearingAccuracyDeg: 25, source: 'gps-compass', anchorRef: null, now, confirmed: false,
    declination: { deg: 1.2, model: 'WMM2025', year: 2026.88 }, seed: { scans: 3 },
  })
  assertEquals(withDeclination.declination, { deg: 1.2, model: 'WMM2025', year: 2026.88 })
  assertEquals(withDeclination.seed, { scans: 3 })
  assertEquals(isConfirmedGeoreference(withDeclination), false)
  ok(withDeclination)
})
