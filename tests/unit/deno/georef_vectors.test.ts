/**
 * The geodesy and the scene frame under a georeference, against numbers this repository did not produce.
 *
 * The placement of a Place on Earth is `T(sceneFromEnu(geodeticToEnu(worldOrigin, origin))) x Ry(180 - bearing) x
 * projectTransform`. Every piece of that is checked here against a value from outside it:
 *
 *  - IOGP Guidance Note 7-2's two worked examples (EPSG methods 9602 and 9836), published to the millimetre, which checks
 *    the formulas and not only the arithmetic: the module has to land on IOGP's own printed numbers.
 *  - Six origin and target pairs (Singapore, London, Sydney, Tromso, Fiji across the antimeridian, Wellington) in
 *    70-digit decimal arithmetic, and four inverse offsets, from `georef_reference.py`: the double-precision pipeline
 *    has to agree to well under a micrometre (R6 measured 3e-9 m; the bound here is 2e-6 m, as the plan states).
 *  - The MathWorks `enu2ecef` documentation example, coarsely against what it prints and exactly against the reference.
 *  - The scene: ENU (3, 4, 5) is (3, 5, -4), the matrix is a rotation (determinant +1), the legacy (east, up, north) is a
 *    mirror (-1), a bearing is the scene direction R6 lists, and east is on the right of a camera facing north in the
 *    scene and on its left in the legacy frame.
 *  - The bearing of the session's +Z from a perfect compass and a random camera, by the formula R6 gives and by the old
 *    sign, which has to fail.
 *  - What the legacy sphere gets wrong at 100 m, which is why placement through a georeference does not use it.
 *
 * Regenerate the reference tables with `python3 -I -B tests/unit/deno/georef_reference.py`. The NOAA rows of R6 T12 are
 * tests/unit/deno/declination.test.ts's, and the GeoPose quaternions of T11 are georef.test.ts's.
 */
import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@^1.0.0'
import {
  ecefToGeodetic,
  enuFromScene,
  enuToGeodetic,
  geodeticToEcef,
  geodeticToEnu,
  sceneFromEnu,
  sceneYawForBearingDeg,
  type Geodetic,
} from '../../../src/world/enu.ts'
import { cameraYawInSessionDeg, composeYUpTransform, geoToEnu, sessionFrameBearingDeg } from '../../../src/world/geo.ts'
import { applyColumnMajor, bearingOfSessionVector, norm360, R2D, rotateByQuat, rotationDeterminant, trueSessionZBearing, type V3 } from './physical_oracle.ts'

const D2R = Math.PI / 180

// ── IOGP Guidance Note 7-2 ───────────────────────────────────────────────────

/** 53 48 33.82 N, 2 07 46.38 E, h 73.00 m, as degrees. */
const IOGP_POINT: Geodetic = { lat: 53.809394444444444, lng: 2.12955, altitudeM: 73 }

Deno.test('IOGP GN 7-2 geographic to geocentric (EPSG 9602 worked example): the module lands on the printed millimetre', () => {
  const ecef = geodeticToEcef(IOGP_POINT)
  // The printed result.
  assertAlmostEquals(ecef.x, 3771793.968, 0.001)
  assertAlmostEquals(ecef.y, 140253.342, 0.001)
  assertAlmostEquals(ecef.z, 5124304.349, 0.001)
  // This script's 70-digit value for the same input, which the printed one rounds.
  assertAlmostEquals(ecef.x, 3.771793967641782e+6, 1e-6)
  assertAlmostEquals(ecef.y, 1.402533418996131e+5, 1e-6)
  assertAlmostEquals(ecef.z, 5.124304349350536e+6, 1e-6)
  // And back: the round trip recovers the geodetic position.
  const back = ecefToGeodetic(ecef)
  assertAlmostEquals(back.lat, IOGP_POINT.lat, 1e-12)
  assertAlmostEquals(back.lng, IOGP_POINT.lng, 1e-12)
  assertAlmostEquals(back.altitudeM, IOGP_POINT.altitudeM, 1e-6)
})

Deno.test('IOGP GN 7-2 geocentric to topocentric (EPSG 9836 worked example): the module lands on the printed millimetre, within 2 mm', () => {
  const printed = { east: -189013.869, north: -128642.04, up: -4220.171 }
  // From the geodetic origin (55 N, 5 E, 200 m) and the geodetic point.
  const fromGeodetic = geodeticToEnu({ lat: 55, lng: 5, altitudeM: 200 }, IOGP_POINT)
  assertAlmostEquals(fromGeodetic.east, printed.east, 0.002)
  assertAlmostEquals(fromGeodetic.north, printed.north, 0.002)
  assertAlmostEquals(fromGeodetic.up, printed.up, 0.002)
  assertAlmostEquals(fromGeodetic.east, -1.890138691509127e+5, 1e-6)
  assertAlmostEquals(fromGeodetic.north, -1.286420398055569e+5, 1e-6)
  assertAlmostEquals(fromGeodetic.up, -4.220170758402032e+3, 1e-6)

  // From the geocentric coordinates IOGP prints for the origin and the point, which is IOGP's own route: they round the
  // geodetic ones (the printed origin is 55.0000000000 N, 5.0000000001 E, 200.0000 m), so the answer moves by about 0.5 mm.
  const origin = ecefToGeodetic({ x: 3652755.3058, y: 319574.6799, z: 5201547.3536 })
  assertAlmostEquals(origin.lat, 55, 1e-9)
  assertAlmostEquals(origin.lng, 5, 1e-9)
  assertAlmostEquals(origin.altitudeM, 200, 1e-3)
  const point = ecefToGeodetic({ x: 3771793.968, y: 140253.342, z: 5124304.349 })
  const fromGeocentric = geodeticToEnu(origin, point)
  assertAlmostEquals(fromGeocentric.east, printed.east, 0.002)
  assertAlmostEquals(fromGeocentric.north, printed.north, 0.002)
  assertAlmostEquals(fromGeocentric.up, printed.up, 0.002)
  assertAlmostEquals(fromGeocentric.east, -1.890138690904270e+5, 1e-5)
  assertAlmostEquals(fromGeocentric.north, -1.286420403054196e+5, 1e-5)
  assertAlmostEquals(fromGeocentric.up, -4.220170822732131e+3, 1e-5)

  // The scene is (E, U, -N): the scene of the example is (-189013.869, -4220.171, +128642.040).
  const scene = sceneFromEnu(fromGeodetic)
  assertAlmostEquals(scene.x, -189013.869, 0.002)
  assertAlmostEquals(scene.y, -4220.171, 0.002)
  assertAlmostEquals(scene.z, 128642.04, 0.002)
})

Deno.test('MathWorks enu2ecef documentation example: coarse against what it prints, exact against the reference, and the round trip', () => {
  const origin: Geodetic = { lat: 45.9132, lng: 36.7484, altitudeM: 1877753.2 }
  const enu = { east: 355601.3, north: -923083.2, up: 1041016.4 }
  const point = enuToGeodetic(origin, enu)
  const ecef = geodeticToEcef(point)
  // Printed in km to four digits: 5.5075e3, 4.5562e3, 6.0128e3 (so 0.06 km on the last printed digit, as R6 states).
  assertAlmostEquals(ecef.x / 1000, 5507.5, 0.06)
  assertAlmostEquals(ecef.y / 1000, 4556.2, 0.06)
  assertAlmostEquals(ecef.z / 1000, 6012.8, 0.06)
  // The reference's 70-digit value.
  assertAlmostEquals(ecef.x, 5.507528889112861e+6, 1e-4)
  assertAlmostEquals(ecef.y, 4.556224139857510e+6, 1e-4)
  assertAlmostEquals(ecef.z, 6.012820752226550e+6, 1e-4)
  // Round trip: the same ENU comes back to 1e-6 m (the iteration of ecefToGeodetic is meant for the heights of a room,
  // and this origin is 1878 km up, which is the case that would show if it did not hold).
  const back = geodeticToEnu(origin, point)
  assertAlmostEquals(back.east, enu.east, 1e-6)
  assertAlmostEquals(back.north, enu.north, 1e-6)
  assertAlmostEquals(back.up, enu.up, 1e-6)
})

// ── Six pairs in 70-digit arithmetic ─────────────────────────────────────────

/** [name, origin, target, [east, north, up]] from georef_reference.py. R6 T4 prints the same numbers to six decimals. */
const PAIRS: Array<[string, Geodetic, Geodetic, [number, number, number]]> = [
  ['singapore', { lat: 1.3521, lng: 103.8198, altitudeM: 15.0 }, { lat: 1.3530, lng: 103.8210, altitudeM: 17.5 }, [1.335467608970531e+2, 9.951771290085934e+1, 2.497820280948402e+0]],
  ['london', { lat: 51.5007, lng: -0.1246, altitudeM: 11.0 }, { lat: 51.5010, lng: -0.1240, altitudeM: 12.0 }, [4.166347639405517e+1, 3.337758851708567e+1, 9.997768189826153e-1]],
  ['sydney', { lat: -33.8568, lng: 151.2153, altitudeM: 5.0 }, { lat: -33.8570, lng: 151.2150, altitudeM: 5.0 }, [-2.776181355340883e+1, -2.218401873205679e+1, -9.907440039195871e-5]],
  ['tromso', { lat: 69.6492, lng: 18.9553, altitudeM: 10.0 }, { lat: 69.6495, lng: 18.9560, altitudeM: 10.0 }, [2.717902643897765e+1, 3.346747599016659e+1, -1.453560421668966e-4]],
  ['fiji_antimeridian', { lat: -16.5000, lng: 179.9999, altitudeM: 20.0 }, { lat: -16.5001, lng: -179.9999, altitudeM: 20.0 }, [2.135288694219333e+1, -1.106643569634956e+1, -4.539039730724750e-5]],
  ['wellington', { lat: -41.2865, lng: 174.7762, altitudeM: 30.0 }, { lat: -41.2860, lng: 174.7770, altitudeM: 35.0 }, [6.701672940843402e+1, 5.552971919365772e+1, 4.999406141582291e+0]],
]

/** What R6 T4 lists, to six decimals: the pairs above must also be exactly these. */
const R6_T4: Record<string, [number, number, number]> = {
  singapore: [133.546761, 99.517713, 2.49782],
  london: [41.663476, 33.377589, 0.999777],
  sydney: [-27.761814, -22.184019, -0.000099],
  tromso: [27.179026, 33.467476, -0.000145],
  fiji_antimeridian: [21.352887, -11.066436, -0.000045],
  wellington: [67.016729, 55.529719, 4.999406],
}

Deno.test('six origin and target pairs (R6 T4): east, north and up to 2e-6 m of the 70-digit reference, and the scene is (E, U, -N)', () => {
  let worst = 0
  for (const [name, origin, target, [east, north, up]] of PAIRS) {
    const got = geodeticToEnu(origin, target)
    worst = Math.max(worst, Math.abs(got.east - east), Math.abs(got.north - north), Math.abs(got.up - up))
    assertAlmostEquals(got.east, east, 2e-6, `${name}: east`)
    assertAlmostEquals(got.north, north, 2e-6, `${name}: north`)
    assertAlmostEquals(got.up, up, 2e-6, `${name}: up`)
    // R6's own printed list: the same pairs, to the decimals it prints.
    const printed = R6_T4[name]!
    assertAlmostEquals(got.east, printed[0], 2e-6 + 1e-6, `${name}: east, as R6 prints it`)
    assertAlmostEquals(got.north, printed[1], 2e-6 + 1e-6, `${name}: north, as R6 prints it`)
    assertAlmostEquals(got.up, printed[2], 2e-6 + 1e-6, `${name}: up, as R6 prints it`)
    // The scene is (E, U, -N): east stays, up becomes y, north becomes -z.
    const scene = sceneFromEnu(got)
    assertEquals(scene, { x: got.east, y: got.up, z: 0 - got.north })
    assertEquals(enuFromScene(scene), got)
  }
  // The double pipeline is a few nanometres from the exact one, a thousand times under the bound.
  assert(worst < 2e-6, `worst ${worst} m`)
  assertEquals(PAIRS.length, 6)
})

Deno.test('inverse offsets from a London origin (R6 T5): the position a given east, north and up away', () => {
  const origin: Geodetic = { lat: 51.5007, lng: -0.1246, altitudeM: 11 }
  // [[east, north, up], [lat, lng, h]] from georef_reference.py; R6 prints the same to nine decimals.
  const cases: Array<[[number, number, number], [number, number, number]]> = [
    [[100, 0, 0], [5.15006999911598929572e+1, -1.23159898965888225143e-1, 1.100078231783417e+1]],
    [[0, 100, 0], [5.15015988113865568322e+1, -1.24600000000000000000e-1, 1.100078436092265e+1]],
    [[0, 0, 10], [5.15007000000000000000e+1, -1.24600000000000000000e-1, 2.100000000000000e+1]],
    [[30, -40, 2], [5.15003404747237660065e+1, -1.24167973224177216922e-1, 1.300019590630177e+1]],
  ]
  for (const [[east, north, up], [lat, lng, h]] of cases) {
    const got = enuToGeodetic(origin, { east, north, up })
    // 1e-10 degrees is 11 micrometres on the ground.
    assertAlmostEquals(got.lat, lat, 1e-10, `${east},${north},${up}: lat`)
    assertAlmostEquals(got.lng, lng, 1e-10, `${east},${north},${up}: lng`)
    assertAlmostEquals(got.altitudeM, h, 1e-6, `${east},${north},${up}: h`)
  }
  // The 0.0008 m on the first one is the Earth's curvature (d squared over 2R at 100 m is 0.78 mm).
  assertAlmostEquals(enuToGeodetic(origin, { east: 100, north: 0, up: 0 }).altitudeM - 11, 0.000782, 1e-6)
  // And a surveyed position comes back from its own offset to a millimetre, through the scene.
  const surveyed: Geodetic = { lat: 51.50078, lng: -0.12431, altitudeM: 12.4 }
  const offset = geodeticToEnu(origin, surveyed)
  const viaScene = enuToGeodetic(origin, enuFromScene(sceneFromEnu(offset)))
  const mm = (deg: number) => deg * D2R * 6_378_137 * 1000
  assert(Math.abs(mm(viaScene.lat - surveyed.lat)) < 1, 'latitude to a millimetre')
  assert(Math.abs(mm(viaScene.lng - surveyed.lng)) * Math.cos(surveyed.lat * D2R) < 1, 'longitude to a millimetre')
  assertAlmostEquals(viaScene.altitudeM, surveyed.altitudeM, 1e-3)
})

// ── The scene frame ──────────────────────────────────────────────────────────

Deno.test('scene mapping (R6 T6): ENU (3, 4, 5) is (3, 5, -4), a rotation of determinant +1, and the legacy frame is a mirror', () => {
  assertEquals(sceneFromEnu({ east: 3, north: 4, up: 5 }), { x: 3, y: 5, z: -4 })
  // The matrix whose columns are the images of east, north, up.
  const e = sceneFromEnu({ east: 1, north: 0, up: 0 })
  const n = sceneFromEnu({ east: 0, north: 1, up: 0 })
  const u = sceneFromEnu({ east: 0, north: 0, up: 1 })
  const det = (a: V3, b: V3, c: V3) => a.x * (b.y * c.z - b.z * c.y) - b.x * (a.y * c.z - a.z * c.y) + c.x * (a.y * b.z - a.z * b.y)
  assertEquals(det(e, n, u), 1)
  // x cross y is +z: the scene is right-handed.
  const x: V3 = { x: 1, y: 0, z: 0 }
  const y: V3 = { x: 0, y: 1, z: 0 }
  const cross = { x: x.y * y.z - x.z * y.y, y: x.z * y.x - x.x * y.z, z: x.x * y.y - x.y * y.x }
  assertEquals(cross, { x: 0, y: 0, z: 1 })
  // The legacy (east, up, north): north is +z, and the determinant is -1.
  const legacy = (v: { east: number; north: number; up: number }) => ({ x: v.east, y: v.up, z: v.north })
  assertEquals(det(legacy({ east: 1, north: 0, up: 0 }), legacy({ east: 0, north: 1, up: 0 }), legacy({ east: 0, north: 0, up: 1 })), -1)
})

Deno.test('a bearing is the scene direction R6 T7 lists, and Ry(180 - bearing) turns +Z onto it', () => {
  const sqrt = Math.SQRT1_2
  const table: Array<[number, V3]> = [
    [0, { x: 0, y: 0, z: -1 }],
    [90, { x: 1, y: 0, z: 0 }],
    [180, { x: 0, y: 0, z: 1 }],
    [270, { x: -1, y: 0, z: 0 }],
    [45, { x: sqrt, y: 0, z: -sqrt }],
  ]
  for (const [bearing, want] of table) {
    const rad = bearing * D2R
    const direction = sceneFromEnu({ east: Math.sin(rad), north: Math.cos(rad), up: 0 })
    assertAlmostEquals(direction.x, want.x, 1e-15, `${bearing}: x`)
    assertAlmostEquals(direction.z, want.z, 1e-15, `${bearing}: z`)
    const m = composeYUpTransform({ x: 0, y: 0, z: 0 }, sceneYawForBearingDeg(bearing), 1)
    const turned = applyColumnMajor(m, { x: 0, y: 0, z: 1 })
    assertAlmostEquals(turned.x, want.x, 1e-15, `${bearing}: Ry(180 - b) z-axis x`)
    assertAlmostEquals(turned.y, 0, 1e-15)
    assertAlmostEquals(turned.z, want.z, 1e-15, `${bearing}: Ry(180 - b) z-axis z`)
    assertAlmostEquals(rotationDeterminant(m), 1, 1e-15)
  }
})

Deno.test('the right of a camera (R6 T9): east when it faces north, south when it faces east; with z north, mirrored', () => {
  // A camera looks along its own -Z and its right is +X (three.js, WebXR), so in a frame it faces `forward`
  // its right is forward x up.
  const up: V3 = { x: 0, y: 1, z: 0 }
  const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
  const rightInScene = (bearing: number) => {
    const rad = bearing * D2R
    return cross(sceneFromEnu({ east: Math.sin(rad), north: Math.cos(rad), up: 0 }), up)
  }
  const north = rightInScene(0)
  assertAlmostEquals(north.x, 1, 1e-15, 'facing north, east is on the right: scene +x')
  assertAlmostEquals(north.z, 0, 1e-15)
  const east = rightInScene(90)
  assertAlmostEquals(east.x, 0, 1e-15)
  assertAlmostEquals(east.z, 1, 1e-15, 'facing east, south is on the right: scene +z')
  // The legacy frame: north is +z, and the same camera has WEST on the right of a north-facing view.
  const rightInLegacy = (bearing: number) => {
    const rad = bearing * D2R
    return cross({ x: Math.sin(rad), y: 0, z: Math.cos(rad) }, up)
  }
  assertAlmostEquals(rightInLegacy(0).x, -1, 1e-15, 'with z north, a north-facing camera has west on its right: a mirror')
  assertAlmostEquals(rightInLegacy(90).z, 1, 1e-15, 'and a camera facing east has +z on its right, which is north there: it should be south')
})

// ── The bearing of the session ───────────────────────────────────────────────

/** Deterministic pseudo-random numbers, so a failure reproduces. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

Deno.test('bearing recovery oracle (R6 T10): B_Z = heading + atan2(f.x, f.z) to 1e-12 degrees, and the old sign fails', () => {
  const next = lcg(20261117)
  let worst = 0
  let oldRuleAgrees = 0
  const n = 2000
  for (let i = 0; i < n; i++) {
    // A random true bearing of the session's +Z (the session started facing psi, so +Z is behind it) and a random camera forward.
    const psi = next() * 360
    const yaw = next() * 360 - 180
    const pitch = (next() - 0.5) * 100
    const f: V3 = {
      x: Math.sin(yaw * D2R) * Math.cos(pitch * D2R),
      y: Math.sin(pitch * D2R),
      z: Math.cos(yaw * D2R) * Math.cos(pitch * D2R),
    }
    // A perfect compass reads the true bearing of the camera's forward direction.
    const heading = bearingOfSessionVector(psi, f)
    const truth = trueSessionZBearing(psi)
    const bz = norm360(heading + Math.atan2(f.x, f.z) * R2D)
    const err = Math.abs(((bz - truth + 540) % 360) - 180)
    worst = Math.max(worst, err)
    // The old sign: heading - atan2(f.x, f.z).
    const old = norm360(heading - Math.atan2(f.x, f.z) * R2D)
    if (Math.abs(((old - truth + 540) % 360) - 180) < 1e-6) oldRuleAgrees++
  }
  assert(worst < 1e-12, `worst ${worst} degrees`)
  // The old rule is right only when the camera faces +-Z, which a random one almost never does.
  assert(oldRuleAgrees < n / 100, `${oldRuleAgrees} of ${n} agree: the oracle cannot tell the two apart`)
  // And through the app's own function with a quaternion: the same truth, to 1e-9.
  for (let i = 0; i < 50; i++) {
    const psi = next() * 360
    const turn = next() * 360 - 180
    const half = (turn * D2R) / 2
    const q = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }
    const f = rotateByQuat(q, { x: 0, y: 0, z: -1 })
    const heading = bearingOfSessionVector(psi, f)
    const got = sessionFrameBearingDeg(heading, q)!
    assertAlmostEquals(Math.abs(((got - trueSessionZBearing(psi) + 540) % 360) - 180), 0, 1e-9)
    assertAlmostEquals(cameraYawInSessionDeg(q), Math.atan2(f.x, f.z) * R2D, 1e-9)
  }
})

// ── The legacy sphere ────────────────────────────────────────────────────────

Deno.test('the legacy sphere (R6 T13): at 51.5 N, 100 m north is 0.055 m out and 100 m east 0.205 m out, which is why placement through a georeference does not use it', () => {
  const start: Geodetic = { lat: 51.5, lng: 10, altitudeM: 0 }
  const pose = (g: { lat: number; lng: number; altitudeM: number }) => ({ lat: g.lat, lng: g.lng, altitudeM: g.altitudeM, bearing: null, accuracyM: null })
  const northTarget = enuToGeodetic(start, { east: 0, north: 100, up: 0 })
  const eastTarget = enuToGeodetic(start, { east: 100, north: 0, up: 0 })
  const north = geoToEnu(pose(start), pose(northTarget))
  const east = geoToEnu(pose(start), pose(eastTarget))
  assertAlmostEquals(Math.abs(north.z - 100), 0.055, 0.002, 'the sphere puts a point 100 m north at ' + north.z)
  assertAlmostEquals(Math.abs(east.x - 100), 0.205, 0.002, 'and a point 100 m east at ' + east.x)
  // The exact module is within a nanometre of the truth it was given.
  assertAlmostEquals(geodeticToEnu(start, northTarget).north, 100, 1e-6)
  assertAlmostEquals(geodeticToEnu(start, eastTarget).east, 100, 1e-6)
})
