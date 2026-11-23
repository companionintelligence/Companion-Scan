/**
 * The locar.js pages' one placement rule (src/ar/locar-placement.ts).
 *
 * The expected distances do not come from the module or from the code it calls. They are the WGS-84 radii of
 * curvature at 51.5 N worked out separately: 0.001 deg of latitude is 111.2578 m (meridional radius M) and 0.001
 * deg of longitude is 69.4405 m (N cos(lat)). Web Mercator would draw the second about 1.6 times longer.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Geodetic } from '../../../src/world/enu.ts'
import type { ProjectLocationEntry } from '../../../src/viewer/geomap.ts'
import {
  compassPoint,
  describePlace,
  latLngAt,
  nearestOnScreen,
  pinnedPlaces,
  scenePlacement,
  toMagneticFrame,
  trueScenePoint,
  viewerCorrection,
} from '../../../src/ar/locar-placement.ts'

/** A `GET /project-locations` entry with no address, scans or capture: only an id, a name and a pin. */
const entry = (projectId: string, name: string, lat: number | null, lng: number | null): ProjectLocationEntry =>
  ({ projectId, name, lat, lng, address: null, scanCount: 0, capturedAt: null })

const LONDON: Geodetic = { lat: 51.5, lng: -0.12, altitudeM: 0 }
const DATE = new Date(Date.UTC(2026, 10, 23))
const close = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`)

test('a point 0.001 deg north is 111.2578 m north, at x 0 and z -111.2578', () => {
  const point = trueScenePoint(LONDON, LONDON.lat + 0.001, LONDON.lng)
  close(point.z, -111.2578, 0.005, 'z')
  close(point.x, 0, 0.001, 'x')
})

test('a point 0.001 deg east is 69.4405 m east, not the 111.5 m Web Mercator would draw', () => {
  const point = trueScenePoint(LONDON, LONDON.lat, LONDON.lng + 0.001)
  close(point.x, 69.4405, 0.005, 'x')
  close(point.z, 0, 0.01, 'z')
})

test('latLngAt puts a point the asked metres away, by the same independent figures', () => {
  const north = latLngAt(LONDON, 0, 111.2578)
  close(north.lat - LONDON.lat, 0.001, 1e-7, 'latitude step')
  const east = latLngAt(LONDON, 69.4405, 0)
  close(east.lng - LONDON.lng, 0.001, 1e-7, 'longitude step')
})

test('the turn into the magnetic frame: D = +10 puts true north 10 deg west of magnetic north', () => {
  const north = toMagneticFrame({ x: 0, z: -100 }, 10)
  close(north.x, -17.3648, 0.001, 'north x')
  close(north.z, -98.4808, 0.001, 'north z')
  const east = toMagneticFrame({ x: 100, z: 0 }, 10)
  close(east.x, 98.4808, 0.001, 'east x')
  close(east.z, -17.3648, 0.001, 'east z')
  assert.deepEqual(toMagneticFrame({ x: 3, z: 4 }, 0), { x: 3, z: 4 })
})

test('declination has the published signs: west in New York, east in Seattle, near zero in London', () => {
  const newYork = viewerCorrection({ lat: 40.7128, lng: -74.006, altitudeM: 0 }, DATE)
  const seattle = viewerCorrection({ lat: 47.6062, lng: -122.3321, altitudeM: 0 }, DATE)
  const london = viewerCorrection(LONDON, DATE)
  assert.ok(newYork.applied && newYork.turnDeg < -10 && newYork.turnDeg > -16, `New York ${newYork.turnDeg}`)
  assert.ok(seattle.applied && seattle.turnDeg > 13 && seattle.turnDeg < 17, `Seattle ${seattle.turnDeg}`)
  assert.ok(london.applied && Math.abs(london.turnDeg) < 3, `London ${london.turnDeg}`)
})

test('a date the model does not cover, or an origin it cannot use, turns nothing', () => {
  const expired = viewerCorrection(LONDON, new Date(Date.UTC(2031, 0, 1)))
  assert.equal(expired.applied, false)
  assert.equal(expired.turnDeg, 0)
  const offGlobe = viewerCorrection({ lat: 95, lng: 0, altitudeM: 0 }, DATE)
  assert.equal(offGlobe.applied, false)
  assert.equal(offGlobe.turnDeg, 0)
})

test('the first point placed is the origin, and later points are metres from it', () => {
  const placement = scenePlacement({ applyDeclination: false, now: () => DATE })
  assert.deepEqual(placement.toScene(LONDON.lng, LONDON.lat), [0, 0])
  assert.deepEqual(placement.origin, LONDON)
  assert.equal(placement.correction, null)
  const [x, z] = placement.toScene(LONDON.lng, LONDON.lat + 0.001)
  close(x, 0, 0.001, 'x')
  close(z, -111.2578, 0.005, 'z')
})

test('an unusable fix is not taken as the origin', () => {
  const placement = scenePlacement({ applyDeclination: false, now: () => DATE })
  assert.deepEqual(placement.toScene(Number.NaN, 51.5), [0, 0])
  assert.deepEqual(placement.toScene(0, 95), [0, 0])
  assert.equal(placement.origin, null)
})

test('with declination on, the camera and a Place keep their true separation, so nothing drifts as you walk', () => {
  const seattle: Geodetic = { lat: 47.6062, lng: -122.3321, altitudeM: 0 }
  const placement = scenePlacement({ applyDeclination: true, now: () => DATE })
  placement.toScene(seattle.lng, seattle.lat)
  const turn = placement.correction?.turnDeg ?? 0
  assert.ok(turn > 13, `Seattle turns ${turn}`)
  const camera = latLngAt(seattle, 50, 0)
  const place = latLngAt(seattle, 100, 0)
  const [cx, cz] = placement.toScene(camera.lng, camera.lat)
  const [px, pz] = placement.toScene(place.lng, place.lat)
  close(Math.hypot(px - cx, pz - cz), 50, 0.01, 'camera to Place')
  // East, turned by +D, sits D degrees north of magnetic east, so at negative z.
  assert.ok(pz < 0, `a Place due true east has z ${pz}`)
})

test('pinnedPlaces keeps only usable pins', () => {
  const pinned = pinnedPlaces([
    entry('a', 'A', 51.5, -0.12),
    entry('b', 'No pin', null, null),
    entry('c', 'Off the globe', 95, 0),
    entry('d', 'Bad longitude', 10, 200),
    entry('e', 'Not a number', Number.NaN, 0),
  ])
  assert.deepEqual(pinned.map((place) => place.projectId), ['a'])
})

test('pinnedPlaces keeps what the route says about a Place, for its card', () => {
  const [place] = pinnedPlaces([
    { projectId: 'p', name: 'Studio', lat: 51.5, lng: -0.12, address: '1 Test Street', scanCount: 3, capturedAt: '2026-11-20T10:00:00Z' },
  ])
  assert.deepEqual(place, {
    projectId: 'p', name: 'Studio', lat: 51.5, lng: -0.12, address: '1 Test Street', scanCount: 3, capturedAt: '2026-11-20T10:00:00Z',
  })
})

test('compassPoint names the nearest of eight points', () => {
  const cases: Array<[number, string]> = [
    [0, 'N'], [22, 'N'], [23, 'NE'], [90, 'E'], [135, 'SE'], [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW'], [359, 'N'],
    [-45, 'NW'], [405, 'NE'],
  ]
  for (const [bearing, point] of cases) assert.equal(compassPoint(bearing), point, `${bearing} deg`)
})

test('nearestOnScreen picks the nearest marker a tap reaches, in front of the camera only', () => {
  const targets = [
    { id: 'far-left', x: 100, y: 100, radiusPx: 48, inFront: true },
    { id: 'far-right', x: 130, y: 100, radiusPx: 48, inFront: true },
    { id: 'behind', x: 120, y: 100, radiusPx: 48, inFront: false },
    { id: 'near', x: 500, y: 500, radiusPx: 150, inFront: true },
  ]
  // Both far markers reach a tap at 120; the right one is nearer. The one behind the camera projects there too.
  assert.equal(nearestOnScreen(targets, 120, 100), 'far-right')
  assert.equal(nearestOnScreen(targets, 104, 100), 'far-left')
  // A near marker counts out to its own size, well past a fingertip.
  assert.equal(nearestOnScreen(targets, 620, 500), 'near')
  assert.equal(nearestOnScreen(targets, 300, 300), null)
  assert.equal(nearestOnScreen([], 0, 0), null)
  // A marker level with the camera plane projects to no finite point and is never picked.
  assert.equal(nearestOnScreen([{ id: 'edge', x: Number.NaN, y: 100, radiusPx: 48, inFront: true }], 100, 100), null)
  assert.equal(nearestOnScreen([{ id: 'edge', x: Number.POSITIVE_INFINITY, y: 100, radiusPx: Number.POSITIVE_INFINITY, inFront: true }], 100, 100), null)
})

test('describePlace gives the true distance and bearing', () => {
  const east = latLngAt(LONDON, 100, 0)
  const south = latLngAt(LONDON, 0, -50)
  const eastInfo = describePlace(LONDON, east)
  const southInfo = describePlace(LONDON, south)
  close(eastInfo.distanceM, 100, 0.01, 'east distance')
  close(eastInfo.trueBearingDeg, 90, 0.01, 'east bearing')
  close(southInfo.distanceM, 50, 0.01, 'south distance')
  close(southInfo.trueBearingDeg, 180, 0.01, 'south bearing')
})
