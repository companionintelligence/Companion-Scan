/**
 * The capture sampler and the server's placement, end to end (src/geo/session-seed.ts into server/world/world_origin.ts): a walk is
 * exported the way the phone exports it, written as the sidecar it uploads, read back through JSON, and placed.
 *
 * The seam this pins is the age of the fix. The sampler records the best fix of the walk's first minute, with the camera's position at
 * it, and when none arrived in that minute the export falls back to the phone's last fix, taken whenever. A server that gates only a
 * fix OLDER than the walk placed that late fix as the scan's position with no lever arm and an uncertainty that did not include the
 * walk: a fix from 75 s in, the phone 30 m down the corridor, placed the scan 30 m from where it began and said 25 m. The fix inside the
 * first minute is the control: carried back to where the session began, to a millimetre.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/geo_session_placement.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { GeoSessionSampler } from '../../../src/geo/session-seed.ts'
import { declinationRecord, seedOriginAccuracyM } from '../../../src/world/georef.ts'
import type { GeoSession } from '../../../src/world/geo-session.ts'
import type { GeoPose } from '../../../src/world/types.ts'
import { placeSceneScan, scanPlacementFacts, type WorldPlacementContext } from '../../../server/world/world_origin.ts'

const LAT0 = 51.5007
const LNG0 = -0.1246
const T0 = Date.parse('2026-11-17T12:00:00.000Z')

const pose = (lat: number, lng: number, extra: Partial<GeoPose> = {}): GeoPose => ({ lat, lng, altitudeM: null, bearing: null, accuracyM: null, ...extra })

/**
 * A straight walk along the session's +Z at `speed` m/s, and an export at `exportAtS`. The session's +Z points east (true bearing 90): the
 * camera looks down session -Z, whose bearing is 90 - 180, and the compass reads that magnetic. A fix arrives at each of `fixes` (seconds
 * into the walk, with the accuracy the platform reported) at the camera's position then.
 */
function walkAndExport(fixes: Array<{ atS: number; accuracyM: number }>, exportAtS: number, speed = 0.4) {
  // A metre east at this latitude on the WGS-84 ellipsoid: the radius of the prime vertical, not the sphere's (which is 0.17% short here).
  const sinLat = Math.sin((LAT0 * Math.PI) / 180)
  const primeVertical = 6_378_137 / Math.sqrt(1 - 0.00669437999014 * sinLat * sinLat)
  const metresEast = (m: number) => LNG0 + (m / (primeVertical * Math.cos((LAT0 * Math.PI) / 180))) * (180 / Math.PI)
  const declination = declinationRecord(LAT0, LNG0, new Date(T0))!.deg
  const magnetic = (((90 - 180 - declination) % 360) + 360) % 360
  let now = T0
  const sampler = new GeoSessionSampler({
    pairedCompass: () => ({ bearingDeg: magnetic, via: 'camera' }) as never,
    compassReading: () => ({ headingDeg: magnetic, northReference: 'magnetic', axis: 'camera', source: 'android-absolute', accuracyDeg: null, sigmaDeg: null }) as never,
    now: () => now,
  })
  const q = { x: 0, y: 0, z: 0, w: 1 }
  let snapshot: Record<string, unknown> | null = null
  for (let ms = 0; ms <= exportAtS * 1000; ms += 250) {
    now = T0 + ms
    sampler.onFrame({ position: { x: 0, y: 1.4, z: speed * (ms / 1000) }, rotation: q }, true, now)
    for (const fix of fixes) {
      if (Math.abs(fix.atS * 1000 - ms) < 125) {
        const where = { lat: LAT0, lng: metresEast(speed * fix.atS), accuracy: fix.accuracyM, altitudeM: null }
        sampler.noteFix(where, now)
        snapshot = { ...where, bearing: null, fixedAt: new Date(now).toISOString(), address: null, displayAddress: null, addressComponents: null }
      }
    }
  }
  const exported = sampler.exportFields(snapshot as never, new Date(T0 + exportAtS * 1000))
  const geo = exported.geoFix!
  const meta = JSON.parse(JSON.stringify({
    projectTransform: null, calibrationMethod: null, calibrationStatus: 'uncalibrated',
    geoLat: geo.lat, geoLng: geo.lng, geoAltitudeM: geo.altitudeM, geoAccuracy: geo.accuracy, geoBearing: geo.bearing, geoFixedAt: geo.fixedAt,
    geoSession: exported.geoSession,
  })) as Record<string, unknown>
  const geoPose = pose(geo.lat, geo.lng, { accuracyM: geo.accuracy, bearing: geo.bearing, fixedAt: geo.fixedAt })
  return { meta, facts: scanPlacementFacts(meta, geoPose, null), origin: pose(LAT0, LNG0, { accuracyM: 4 }) }
}

const context = (worldOrigin: GeoPose): WorldPlacementContext => ({ convention: 'scene', georeference: null, georefVersion: 0, frameMethod: 'two-point-ground', worldOrigin, maxRadiusM: 250 })

test('a fix from after the walk\'s first minute is not where the scan began: the capture records none, and the server refuses the one it has', () => {
  // Indoors the first fixes are 60 m (the sampler drops what is worse than 50 m), and a 12 m fix arrives at 75 s, when the phone is 30 m
  // along the walk. The page's last fix is that one, and the export falls back to it.
  const late = walkAndExport([{ atS: 5, accuracyM: 60 }, { atS: 15, accuracyM: 60 }, { atS: 35, accuracyM: 60 }, { atS: 75, accuracyM: 12 }], 100)
  assert.equal((late.meta['geoSession'] as GeoSession).fix, null, 'the capture holds no fix from the first minute')
  assert.ok(Math.abs((Date.parse(late.facts.geoPose.fixedAt!) - T0) / 1000 - 75) < 1e-6, 'and the position it falls back to is from 75 s in')
  const placed = placeSceneScan(late.facts, context(late.origin), 0)
  assert.equal(placed.source, 'grid', 'a position 30 m down the walk, claimed at 25 m with no lever arm, is not a placement')
  assert.equal(placed.gridReason, 'fix-age')
  assert.equal(placed.uncertaintyM, null)
  // Each of the late-fix timings the review tried, at each walking speed, is refused: the error is the distance walked, and nothing carries it back.
  for (const speed of [0.1, 0.25, 0.4, 0.6]) {
    const walked = walkAndExport([{ atS: 70, accuracyM: 12 }], 100, speed)
    assert.equal(placeSceneScan(walked.facts, context(walked.origin), 0).gridReason, 'fix-age', `speed ${speed}`)
  }
})

test('a fix inside the first minute is carried back to where the session began, to a millimetre, and the walk is in the uncertainty', () => {
  const early = walkAndExport([{ atS: 20, accuracyM: 6 }], 100)
  const session = early.meta['geoSession'] as GeoSession
  assert.equal(session.fix!.offsetS, 20)
  assert.ok(Math.abs(session.fix!.sessionZ! - 8) < 1e-6)
  const placed = placeSceneScan(early.facts, context(early.origin), 0)
  assert.equal(placed.source, 'gps-compass')
  assert.equal(placed.gridReason, null)
  // The session began at the world's origin: the matrix puts it there, and its +Z is east, the scene's +X.
  assert.ok(Math.abs(placed.matrix[12]!) < 1e-3, `x ${placed.matrix[12]}`)
  assert.ok(Math.abs(placed.matrix[14]!) < 1e-3, `z ${placed.matrix[14]}`)
  assert.ok(Math.abs(placed.matrix[8]! - 1) < 1e-6)
  assert.ok(Math.abs(placed.matrix[10]!) < 1e-6)
  assert.ok(placed.uncertaintyM! > seedOriginAccuracyM(6), 'the bearing\'s error over the 8 m walked is added')
  // The last second of the minute is inside it, a second after is not.
  assert.equal(placeSceneScan(walkAndExport([{ atS: 60, accuracyM: 6 }], 100).facts, context(early.origin), 0).source, 'gps-compass')
  const justAfter = walkAndExport([{ atS: 61, accuracyM: 6 }], 100)
  assert.equal((justAfter.meta['geoSession'] as GeoSession).fix, null, 'the sampler keeps none from after the first minute')
  assert.equal(placeSceneScan(justAfter.facts, context(early.origin), 0).gridReason, 'fix-age')
})
