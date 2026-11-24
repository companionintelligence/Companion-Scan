/**
 * The session record a scan's sidecar carries (src/world/geo-session.ts) and how defensively it is read.
 *
 * The phone writes `geoSession` into the upload sidecar and the server reads it when it places a scan that has no calibration
 * (server/world/world_origin.ts), so this reader is the contract between them. A sidecar can be hand-edited, truncated or written
 * by a later build, and a placement made from half a record would be a claim nothing backs (ADR 0005 rule 3). What is pinned:
 *
 *  - a good record reads back whole, and anything else it carried is dropped, not trusted;
 *  - a record of another version, or with no usable start time, is no record;
 *  - a fix with a negative offset is no fix, and a position in the session is a pair or it is nothing;
 *  - a bearing is in [0, 360) with a spread that is not negative, a sigma that is not under the spread, a whole number of samples
 *    from 1 and a span that is not negative, or it is no bearing; a compass source that is not one of the two is left out
 *    without costing the bearing;
 *  - a declination is within 90 degrees, of the model that is used, with a year; and a bearing with no declination is no bearing,
 *    because a true bearing is a magnetic one plus a declination and nothing says what north it counts from.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/geo_session.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { GEO_SESSION_KEY, GEO_SESSION_VERSION, parseGeoSession } from '../../../src/world/geo-session.ts'

const GOOD = {
  v: 1,
  startedAt: '2026-11-17T10:00:00.000Z',
  fix: { offsetS: 12.5, sessionX: 0.4, sessionZ: -0.2 },
  bearing: { deg: 200.5, spreadDeg: 6, sigmaDeg: 15, samples: 30, spanS: 9.5, source: 'android-absolute' },
  declination: { deg: 1.2, model: 'WMM2025', year: 2026.88 },
}

/** The good record with `changes` laid over it, `undefined` removing a field. */
function with_(changes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...GOOD }
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete out[key]
    else out[key] = value
  }
  return out
}

test('the record is versioned, and keyed where the phone writes it', () => {
  assert.equal(GEO_SESSION_VERSION, 1)
  assert.equal(GEO_SESSION_KEY, 'geoSession')
})

test('a good record reads back whole, and nothing else it carried comes with it', () => {
  assert.deepEqual(parseGeoSession(GOOD), GOOD)
  const extra = parseGeoSession({
    ...GOOD,
    fix: { ...GOOD.fix, note: 'x' },
    bearing: { ...GOOD.bearing, note: 'x' },
    declination: { ...GOOD.declination, note: 'x' },
    extra: 'dropped',
  })
  assert.deepEqual(extra, GOOD, 'a field the contract does not name is not carried')
})

test('anything that is not a record of this version with a usable start time is no record', () => {
  for (const bad of [null, undefined, 'geoSession', 7, [], [GOOD], { ...GOOD, v: 2 }, { ...GOOD, v: '1' }, with_({ v: undefined })]) {
    assert.equal(parseGeoSession(bad), null, JSON.stringify(bad))
  }
  for (const startedAt of [undefined, null, 17, '', 'yesterday', '2026-11-17', '2026-11-17 10:00:00', '2026-13-45T25:61:61Z']) {
    assert.equal(parseGeoSession(with_({ startedAt })), null, `startedAt ${JSON.stringify(startedAt)}`)
  }
  // A time zone offset is a time: the offset is part of the ISO form the phone writes.
  assert.equal(parseGeoSession(with_({ startedAt: '2026-11-17T10:00:00+01:00' }))?.startedAt, '2026-11-17T10:00:00+01:00')
})

test('a fix is an offset from the start that is not negative, and a position in the session is a pair or it is nothing', () => {
  for (const fix of [null, undefined, 'fix', [], { offsetS: -0.1, sessionX: 1, sessionZ: 2 }, { offsetS: Number.NaN, sessionX: 1, sessionZ: 2 }, { offsetS: '3', sessionX: 1, sessionZ: 2 }, {}]) {
    assert.equal(parseGeoSession(with_({ fix }))?.fix, null, `fix ${JSON.stringify(fix)}`)
  }
  assert.deepEqual(parseGeoSession(with_({ fix: { offsetS: 0, sessionX: 1, sessionZ: 2 } }))?.fix, { offsetS: 0, sessionX: 1, sessionZ: 2 }, 'an offset of 0 is a fix')
  // One coordinate of the camera's position is not a lever arm: neither is kept, and the fix still is.
  for (const fix of [{ offsetS: 7, sessionX: 1 }, { offsetS: 7, sessionZ: 2 }, { offsetS: 7, sessionX: 1, sessionZ: 'two' }, { offsetS: 7, sessionX: Number.NaN, sessionZ: 2 }, { offsetS: 7 }]) {
    assert.deepEqual(parseGeoSession(with_({ fix }))?.fix, { offsetS: 7, sessionX: null, sessionZ: null }, JSON.stringify(fix))
  }
})

test('a bearing is a mean in [0, 360) with a spread, a sigma no smaller than it, samples and a span, or it is no bearing', () => {
  const bearing = (changes: Record<string, unknown>) => ({ ...GOOD.bearing, ...changes })
  const edge = parseGeoSession(with_({ bearing: bearing({ deg: 0 }) }))?.bearing
  assert.equal(edge?.deg, 0, '0 is north')
  assert.equal(parseGeoSession(with_({ bearing: bearing({ deg: 359.999 }) }))?.bearing?.deg, 359.999)
  const refused: Array<[string, Record<string, unknown>]> = [
    ['360', { deg: 360 }],
    ['negative', { deg: -1 }],
    ['not a number', { deg: Number.NaN }],
    ['a string', { deg: '200' }],
    ['a negative spread', { spreadDeg: -1 }],
    ['an infinite spread', { spreadDeg: Number.POSITIVE_INFINITY }],
    ['a sigma under the spread', { spreadDeg: 20, sigmaDeg: 19.9 }],
    ['no sigma', { sigmaDeg: undefined }],
    ['no samples', { samples: 0 }],
    ['half a sample', { samples: 2.5 }],
    ['a negative span', { spanS: -1 }],
    ['no span', { spanS: undefined }],
  ]
  for (const [why, changes] of refused) {
    const changed = bearing(changes)
    for (const key of Object.keys(changes)) if (changes[key] === undefined) delete (changed as Record<string, unknown>)[key]
    assert.equal(parseGeoSession(with_({ bearing: changed }))?.bearing, null, why)
  }
  // A sigma equal to the spread is the least a record may say, and a spread of 0 is a spread.
  assert.equal(parseGeoSession(with_({ bearing: bearing({ spreadDeg: 15, sigmaDeg: 15 }) }))?.bearing?.sigmaDeg, 15)
  assert.equal(parseGeoSession(with_({ bearing: bearing({ spreadDeg: 0, sigmaDeg: 15 }) }))?.bearing?.spreadDeg, 0)
  for (const value of [null, undefined, 'north', []]) assert.equal(parseGeoSession(with_({ bearing: value }))?.bearing, null)
  // The platform's compass: one of the two it knows, or left out, and the bearing stays.
  assert.equal(parseGeoSession(with_({ bearing: bearing({ source: 'ios-compass' }) }))?.bearing?.source, 'ios-compass')
  assert.equal(parseGeoSession(with_({ bearing: bearing({ source: 'magic' }) }))?.bearing?.source, null)
  assert.equal(parseGeoSession(with_({ bearing: bearing({ source: undefined }) }))?.bearing?.deg, 200.5, 'an unnamed compass does not cost the bearing')
})

test('a declination is within 90 degrees, of the model that is used, with a year; and without one there is no true bearing', () => {
  const declination = (changes: Record<string, unknown>) => ({ ...GOOD.declination, ...changes })
  assert.equal(parseGeoSession(with_({ declination: declination({ deg: -90 }) }))?.declination?.deg, -90)
  assert.equal(parseGeoSession(with_({ declination: declination({ deg: 90 }) }))?.declination?.deg, 90)
  for (const bad of [declination({ deg: 90.1 }), declination({ deg: -91 }), declination({ deg: Number.NaN }), declination({ model: 'WMM2020' }), declination({ model: undefined }), declination({ year: Number.NaN }), declination({ year: '2026' }), null, undefined, 'WMM2025', []]) {
    const parsed = parseGeoSession(with_({ declination: bad }))
    assert.equal(parsed?.declination, null, JSON.stringify(bad))
    // A true bearing is a magnetic one plus a declination: the record keeps the fix and says no bearing.
    assert.equal(parsed?.bearing, null, `no declination, so no bearing: ${JSON.stringify(bad)}`)
    assert.notEqual(parsed?.fix, null, 'the fix is not lost with the declination')
  }
})
