/**
 * What a capture session records of where it is and which way it faces (src/geo/session-seed.ts), against a physical model that
 * shares no code with the app (tests/unit/deno/physical_oracle.ts, which imports nothing).
 *
 * The compass of the model is perfect, and magnetic: it reads the true bearing of the camera's forward direction less the
 * declination of the place, as a phone's does. A session starts facing `psi` and the camera turns and tilts through the walk. What
 * must come out is the TRUE bearing of the session's +Z, whatever the camera did, which is what makes the sampler's sign, its
 * pairing of the compass with the pose, its steady-sample rule and its declination all load-bearing:
 *
 *  - with the camera's yaw added to the reading (`B + yaw`) the bearing does not move while the phone turns, and with it
 *    subtracted it moves by twice the turn: a sampler on the old sign records a spread of tens of degrees and is refused by every
 *    gate, so the first test is also the sign guard;
 *  - the declination is added: east positive, true = magnetic + D, and a place with no declination (a date outside WMM2025)
 *    gives no bearing rather than a magnetic one;
 *  - only steady samples count (a phone swinging at 90 degrees a second reads where it was), and a walk of too few or too short
 *    a stretch of them has no bearing;
 *  - the position is the best fix of the first minute, with the camera's place in the session when it was taken, and a fix that
 *    came after the first minute, or before the walk began, is not it; with none, the tracker's snapshot stands;
 *  - the record it writes is one the server's reader takes, and the walk can be begun again.
 *
 * main.ts is one DOM module and cannot be imported under Node, so its wiring is read as text at the end, in a test named
 * "source shape:" that claims no behaviour.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/geo_session_seed.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GeoSessionSampler, MAX_KEPT_FIXES, SAMPLE_INTERVAL_MS, type SessionSamplerSources } from '../../../src/geo/session-seed.ts'
import type { CompassReading } from '../../../src/geo/compass-heading.ts'
import type { GeoFix } from '../../../src/geo/geo-tracker.ts'
import { parseGeoSession } from '../../../src/world/geo-session.ts'
import { declinationRecord } from '../../../src/world/georef.ts'
import { cameraRotation, norm360, perfectCompassBearing, trueSessionZBearing, type Q } from '../deno/physical_oracle.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')

const DATE = new Date('2026-11-17T12:00:00Z')
const PLACE = { lat: 51.5007, lng: -0.1246 }
const DECLINATION = declinationRecord(PLACE.lat, PLACE.lng, DATE)!.deg
const T0 = Date.parse('2026-11-17T11:50:00Z')

const angDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180

interface Walk {
  sampler: GeoSessionSampler
  clock: { ms: number }
  frame: (turnLeftDeg: number, downDeg?: number, position?: { x: number; z: number }, usable?: boolean) => void
}

/** A sampler on a perfect, magnetic compass, in a session that started facing `psi`, with a clock the test moves. */
function walk(psi: number, reading: Partial<CompassReading> = {}, declination = DECLINATION): Walk {
  const clock = { ms: T0 }
  const sources: SessionSamplerSources = {
    // What the phone reads: the camera's bearing, from magnetic north.
    pairedCompass: (q) => ({ bearingDeg: norm360(perfectCompassBearing(psi, q) - declination), via: 'camera' }),
    compassReading: () => ({
      headingDeg: 0,
      northReference: 'magnetic',
      axis: 'camera',
      source: 'android-absolute',
      accuracyDeg: null,
      sigmaDeg: null,
      ...reading,
    }),
    now: () => clock.ms,
  }
  const sampler = new GeoSessionSampler(sources)
  return {
    sampler,
    clock,
    frame: (turnLeftDeg, downDeg = 0, position = { x: 0, z: 0 }, usable = true) => {
      const q: Q = cameraRotation(turnLeftDeg, downDeg)
      sampler.onFrame({ position: { x: position.x, y: 1.3, z: position.z }, rotation: q }, usable, clock.ms)
    },
  }
}

/** Frames every 16 ms (60 Hz) for `seconds`, the camera turning at `degPerSecond` from `startDeg`, level or tilted. */
function run(w: Walk, seconds: number, startDeg: number, degPerSecond: number, down = 0): number {
  let turn = startDeg
  for (let t = 0; t < seconds * 1000; t += 16) {
    w.frame(turn, down)
    turn += (degPerSecond * 16) / 1000
    w.clock.ms += 16
  }
  return turn
}

const snapshot = (extra: Partial<GeoFix> = {}): GeoFix => ({
  lat: PLACE.lat,
  lng: PLACE.lng,
  accuracy: 30,
  altitudeM: 40,
  bearing: 123,
  fixedAt: new Date(T0 - 5000).toISOString(),
  address: '1 Example Road',
  displayAddress: '1 Example Road, Testville',
  addressComponents: { road: 'Kitchen Road' },
  ...extra,
})

test('the session bearing is the true bearing of the session +Z whatever the camera did, for every start heading, turn and tilt (and fails on the old sign)', () => {
  for (const psi of [0, 37, 90, 137, 200, 290, 359]) {
    const w = walk(psi)
    // Steady stretches at different headings and tilts, with the camera swinging fast between them.
    let turn = 0
    for (const [hold, down] of [[0, 0], [60, 25], [-90, 60], [130, 0], [-30, 85]] as const) {
      turn = run(w, 1.5, hold, 0, down)
      turn = run(w, 0.5, turn, 90, down)
    }
    const { geoSession } = w.sampler.exportFields(snapshot(), DATE)
    assert.ok(geoSession?.bearing, `psi ${psi}: a bearing came out of ${w.sampler.steadySamples} steady samples`)
    assert.ok(Math.abs(angDiff(geoSession.bearing.deg, trueSessionZBearing(psi))) < 1e-9, `psi ${psi}: ${geoSession.bearing.deg} against ${trueSessionZBearing(psi)}`)
    // The camera held at five different headings gave one bearing: the spread is numerical noise, and sigma is the floor.
    assert.ok(geoSession.bearing.spreadDeg < 1e-4, `psi ${psi}: spread ${geoSession.bearing.spreadDeg}`)
    assert.equal(geoSession.bearing.sigmaDeg, 15)
    assert.equal(geoSession.bearing.source, 'android-absolute')
    assert.ok(geoSession.bearing.samples >= 8 && geoSession.bearing.spanS >= 2)
  }
  // The same walk with the sign of the yaw reversed (what `sessionFrameBearingDeg` did before it was corrected) spreads the bearing
  // by tens of degrees: this is what the sampler would record on the old rule, and what the gate at 30 degrees refuses.
  const w = walk(137)
  const wrong: number[] = []
  for (const hold of [0, 60, -90, 130]) {
    const q = cameraRotation(hold, 0)
    const compass = norm360(perfectCompassBearing(137, q) - DECLINATION)
    const yaw = (Math.atan2(2 * (q.x * q.z + q.y * q.w) * -1, 2 * (q.x * q.x + q.y * q.y) - 1) * 180) / Math.PI
    wrong.push(norm360(compass - yaw))
  }
  assert.ok(Math.max(...wrong) - Math.min(...wrong) > 30, 'the old sign gives a wide spread, which is how it would have been caught')
  void w
})

test('the declination is added (east positive), and a place or a date with none gives no bearing, never a magnetic one', () => {
  assert.notEqual(Math.round(DECLINATION * 10), 0, 'London has a declination to test with')
  const w = walk(200)
  run(w, 4, 0, 0)
  const { geoSession } = w.sampler.exportFields(snapshot(), DATE)
  assert.deepEqual(geoSession?.declination, declinationRecord(PLACE.lat, PLACE.lng, DATE))
  assert.ok(Math.abs(angDiff(geoSession!.bearing!.deg, trueSessionZBearing(200))) < 1e-9, 'the magnetic readings plus D are the true bearing')
  // Adding it the wrong way, or not at all, would be off by D or 2D: the test above passes only when it is +D.
  assert.ok(Math.abs(angDiff(geoSession!.bearing!.deg, trueSessionZBearing(200) - DECLINATION)) > 0.5)

  // After WMM2025 ends: no declination, so no true bearing, and the record says so.
  const later = w.sampler.exportFields(snapshot(), new Date('2031-01-01T00:00:00Z')).geoSession
  assert.equal(later?.declination, null)
  assert.equal(later?.bearing, null)
  // And with no position at all there is no place to take a declination at.
  const none = walk(10)
  run(none, 4, 0, 0)
  assert.equal(none.sampler.exportFields(null, DATE).geoSession?.bearing, null)
})

test('only steady samples count, and a walk of too few or too short a stretch of them has no bearing', () => {
  // A camera that never stops turning: 90 degrees a second is not steady, so nothing is recorded.
  const turning = walk(90)
  run(turning, 8, 0, 90)
  assert.equal(turning.sampler.steadySamples, 0)
  assert.equal(turning.sampler.exportFields(snapshot(), DATE).geoSession?.bearing, null)
  // Held still for under the minimum: 1 s is 4 samples.
  const brief = walk(90)
  run(brief, 1, 0, 0)
  assert.ok(brief.sampler.steadySamples < 8)
  assert.equal(brief.sampler.exportFields(snapshot(), DATE).geoSession?.bearing, null)
  // Enough samples but crowded into too little time cannot happen at the sampling rate; 2 s of steady holds is enough.
  const enough = walk(90)
  run(enough, 2.6, 0, 0)
  assert.ok(enough.sampler.exportFields(snapshot(), DATE).geoSession?.bearing, `${enough.sampler.steadySamples} samples`)
  // Samples are taken about every 250 ms, not at the frame rate: 4 seconds is about 16, not 250.
  const rate = walk(90)
  run(rate, 4, 0, 0)
  assert.ok(rate.sampler.steadySamples >= 14 && rate.sampler.steadySamples <= 17, `${rate.sampler.steadySamples}`)
  assert.equal(SAMPLE_INTERVAL_MS, 250)
})

test('a pose the runtime does not trust, or a compass that cannot be paired, takes no sample, and a lost stretch is not carried across', () => {
  const w = walk(90)
  for (let i = 0; i < 40; i++) {
    w.frame(0, 0, { x: 0, z: 0 }, false)
    w.clock.ms += 250
  }
  assert.equal(w.sampler.steadySamples, 0, 'degraded tracking takes no sample')
  assert.ok(w.sampler.startedAt !== null, 'but the walk has begun')
  // A compass with nothing to give (the camera straight down, no reading yet) takes none either.
  const clock = { ms: T0 }
  const nothing = new GeoSessionSampler({ pairedCompass: () => null, compassReading: () => null, now: () => clock.ms })
  for (let i = 0; i < 40; i++) {
    nothing.onFrame({ position: { x: 0, y: 1, z: 0 }, rotation: cameraRotation(0, 0) }, true, clock.ms)
    clock.ms += 250
  }
  assert.equal(nothing.steadySamples, 0)
  // A pose that is not a number is ignored, and does not begin a walk.
  const bad = new GeoSessionSampler({ pairedCompass: () => ({ bearingDeg: 1, via: 'camera' }), compassReading: () => null, now: () => clock.ms })
  bad.onFrame({ position: { x: Number.NaN, y: 0, z: 0 }, rotation: cameraRotation(0, 0) })
  assert.equal(bad.startedAt, null)
})

test('the position is the best fix of the first minute, with the camera\'s place in the session, and the snapshot stands when there is none', () => {
  const w = walk(10)
  // Fixes before the first pose are the phone\'s last, not part of the walk: not kept, whatever time they say (the second one says 5 s
  // after the epoch, which a walk that began then would have in its first minute).
  w.sampler.noteFix({ lat: 40, lng: 1, accuracy: 1, altitudeM: null }, T0 - 1000)
  w.sampler.noteFix({ lat: 41, lng: 1, accuracy: 1, altitudeM: null }, 5_000)
  w.frame(0, 0, { x: 0, z: 0 })
  const fixAt = (seconds: number, accuracy: number, at: { x: number; z: number }, lat = PLACE.lat + seconds * 1e-6) => {
    w.clock.ms = T0 + seconds * 1000
    w.frame(0, 0, at)
    w.sampler.noteFix({ lat, lng: PLACE.lng, accuracy, altitudeM: 12 + seconds }, w.clock.ms)
  }
  fixAt(5, 20, { x: 1, z: 2 })
  fixAt(30, 8, { x: -4, z: 9 })
  fixAt(45, 8, { x: -6, z: 12 })
  fixAt(60, 25, { x: -7, z: 13 })
  fixAt(61, 2, { x: -8, z: 14 })
  const out = w.sampler.exportFields(snapshot({ accuracy: 50 }), DATE)
  assert.equal(out.geoFix?.accuracy, 8, 'the best accuracy of the first minute, not the 2 m one after it, not the snapshot\'s')
  assert.equal(out.geoFix?.lat, PLACE.lat + 30 * 1e-6, 'the earlier of two equally good')
  assert.equal(out.geoFix?.altitudeM, 42, 'its height as the platform said it')
  assert.equal(out.geoFix?.fixedAt, new Date(T0 + 30_000).toISOString(), 'taken 30 s into the walk')
  assert.equal(out.geoFix?.bearing, 123, 'the device compass at export stays what it was')
  assert.deepEqual(out.geoSession?.fix, { offsetS: 30, sessionX: -4, sessionZ: 9 }, 'the camera was 9 m along +Z and 4 m along -X of the session origin')
  assert.equal(out.geoSession?.startedAt, new Date(T0).toISOString())
  // The address is the snapshot's, kept because it is still about the same place; a fix of another street drops it.
  assert.equal(out.geoFix?.address, '1 Example Road')
  assert.equal(w.sampler.exportFields(snapshot({ lat: 51.6 }), DATE).geoFix?.address, null)
  assert.equal(w.sampler.exportFields(snapshot({ lat: 51.6 }), DATE).geoFix?.displayAddress, null)

  // No fix in the first minute: the tracker's snapshot stands, as it did, and the record says there was no walk fix.
  const late = walk(10)
  late.frame(0)
  late.clock.ms = T0 + 90_000
  late.frame(0)
  late.sampler.noteFix({ lat: 40, lng: 1, accuracy: 3, altitudeM: null }, late.clock.ms)
  const fallback = late.sampler.exportFields(snapshot(), DATE)
  assert.deepEqual(fallback.geoFix, snapshot())
  assert.equal(fallback.geoSession?.fix, null)
  // No snapshot and no fix: a session record and no position.
  const bare = walk(10)
  bare.frame(0)
  const noPosition = bare.sampler.exportFields(null, DATE)
  assert.equal(noPosition.geoFix, undefined)
  assert.ok(noPosition.geoSession)
  // A fix that is not usable is not kept (the 70 m one has no accuracy the seed can use).
  const poor = walk(10)
  poor.frame(0)
  poor.clock.ms = T0 + 2000
  poor.sampler.noteFix({ lat: PLACE.lat, lng: PLACE.lng, accuracy: 70, altitudeM: null }, poor.clock.ms)
  assert.deepEqual(poor.sampler.exportFields(snapshot(), DATE).geoFix, snapshot())
})

test('at most 128 fixes of a walk are kept, the first ones, and the best of the first minute among them is the position', () => {
  assert.equal(MAX_KEPT_FIXES, 128)
  const w = walk(10)
  w.frame(0)
  // 150 fixes, 0.3 s apart (so all within the first minute), each more accurate than the last: the 129th and later are not kept.
  for (let i = 0; i < 150; i += 1) {
    w.clock.ms = T0 + i * 300
    w.sampler.noteFix({ lat: PLACE.lat + i * 1e-7, lng: PLACE.lng, accuracy: 40 - i * 0.2, altitudeM: null }, w.clock.ms)
  }
  const out = w.sampler.exportFields(snapshot({ accuracy: 50 }), DATE)
  assert.equal(out.geoFix?.accuracy, 40 - 127 * 0.2, 'the 128th fix is the last one kept, and the best of those')
  assert.equal(out.geoFix?.lat, PLACE.lat + 127 * 1e-7)
})

test('an iPhone is never claimed better than its own uncertainty, and a window of unsteady readings cannot lower it', () => {
  const w = walk(90, { source: 'ios-compass', sigmaDeg: 25 })
  run(w, 4, 0, 0)
  const bearing = w.sampler.exportFields(snapshot(), DATE).geoSession?.bearing
  assert.equal(bearing?.sigmaDeg, 25)
  assert.equal(bearing?.source, 'ios-compass')
  // A platform that reports a larger accuracy than the floor raises it.
  const worse = walk(90, { source: 'ios-compass', sigmaDeg: 40 })
  run(worse, 4, 0, 0)
  assert.equal(worse.sampler.exportFields(snapshot(), DATE).geoSession?.bearing?.sigmaDeg, 40)
})

test('the record is one the server reads, and a cleared scan begins another walk', () => {
  const w = walk(250)
  run(w, 5, 0, 0)
  w.clock.ms = T0 + 12_000
  w.frame(0, 0, { x: 3, z: -1 })
  w.sampler.noteFix({ lat: PLACE.lat, lng: PLACE.lng, accuracy: 6, altitudeM: null }, w.clock.ms)
  const out = w.sampler.exportFields(snapshot(), DATE)
  const written = JSON.parse(JSON.stringify(out.geoSession))
  const read = parseGeoSession(written)
  assert.deepEqual(read, out.geoSession, 'it round trips through JSON and the reader that the server places by')
  assert.equal(read?.bearing !== null, true)

  w.sampler.reset()
  assert.equal(w.sampler.startedAt, null)
  assert.equal(w.sampler.steadySamples, 0)
  assert.deepEqual(w.sampler.exportFields(null, DATE), {}, 'nothing from the walk before it')
  assert.deepEqual(w.sampler.exportFields(snapshot(), DATE), { geoFix: snapshot() }, 'with no walk the snapshot is all there is, as before')
})

test('source shape: the page hands the sampler its poses and fixes, writes what it records, and clears it with the scan', () => {
  const main = readFileSync(join(ROOT, 'src/main.ts'), 'utf8')
  const gltf = readFileSync(join(ROOT, 'src/export/gltf.ts'), 'utf8')
  const tracker = readFileSync(join(ROOT, 'src/geo/geo-tracker.ts'), 'utf8')
  assert.match(main, /new GeoSessionSampler\(\{ pairedCompass: \(rotation\) => geoTracker\.pairedCompass\(rotation\)/, 'the sampler reads the tracker\'s own compass pairing')
  assert.match(main, /geoTracker\.onPosition = \(fix, takenAtMs\) => geoSession\.noteFix\(fix, takenAtMs\)/, 'every position fix is handed over')
  assert.match(main, /geoSession\.onFrame\(frame\.pose, trackingUsable && !held\)/, 'every AR pose is, with whether the runtime trusts it')
  assert.match(main, /reanchor\.noteScanReset\(\)\n\s*geoSession\.reset\(\)/, 'a cleared scan begins another walk')
  assert.equal((main.match(/\.\.\.geoSession\.exportFields\(geoTracker\.snapshot\(\)\)/g) ?? []).length, 3, 'the three exports write the best fix and the record')
  assert.equal((gltf.match(/\.\.\.\(geoSession \? \{ geoSession \} : \{\}\)/g) ?? []).length, 2, 'the sidecar and the GLB extras both carry the record, when there is one')
  assert.match(tracker, /this\._onPosition\?\.\(fix, pos\.timestamp\)/, 'the tracker says when a position, and only a position, arrives')
  // The orientation handler and the address lookup update the fix and are not new positions: they must not call it.
  assert.equal((tracker.match(/_onPosition\?\./g) ?? []).length, 1)
})
