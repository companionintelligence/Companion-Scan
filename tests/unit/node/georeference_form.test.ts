/**
 * The Place location and heading panel's logic (src/viewer/georeference-form.ts): what a person's numbers become, what the record claims
 * about them, and the words that say so. The DOM half is src/viewer/georeference-panel.ts, which tests/mock-georef-hud.spec.ts runs in a
 * browser; every decision and sentence is here, where it can be reached without one.
 *
 * What is pinned:
 *
 *  - numbers: what is a number (a comma decimal, a unicode minus), and that a field that is empty or not a number is said to be, not
 *    guessed;
 *  - the confirmed and the approximate: Save makes a record with no `confirmedAt`, Confirm sets it, and a compass estimate is never
 *    a confirmed record by being an estimate or by filling the form;
 *  - the accuracy floors: typed numbers cannot claim better than a map click, a compass seed not better than a compass, and the form
 *    refuses under them in words before the server has to;
 *  - the source: `gps-compass` only for an unedited estimate, `typed` for anything the person changed, and the saved record's own
 *    source (with its declination, scans and height) for numbers saved again without a change: the buttons decide only confirmation;
 *  - the frame: the record is made against the frame the Place holds (its id), and a record of an earlier frame says so;
 *  - the words never say verified, exact, accurate to or within, and a seed says approximate.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/georeference_form.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyEstimate,
  buildFromForm,
  claimText,
  CONFIRM_LABEL,
  CONFIRMED_MESSAGE,
  COMPASS_CAVEAT,
  EARLIER_FRAME_TEXT,
  estimateText,
  type FormState,
  HEADING_LABEL,
  isEarlierFrame,
  NO_ESTIMATE_LABEL,
  NO_LOCATION_TEXT,
  OLD_SCANS_TEXT,
  PANEL_HINT,
  PANEL_TITLE,
  parseNumber,
  REPLACES_CONFIRMED_TEXT,
  SAVE_APPROXIMATE_LABEL,
  SAVED_APPROXIMATE_MESSAGE,
  SAVED_APPROXIMATE_TEXT,
  savedStatusText,
  sourceOf,
  startingValues,
  TYPED_HEADING_ACCURACY_DEFAULT_DEG,
  useEstimateLabel,
  valuesFromRecord,
} from '../../../src/viewer/georeference-form.ts'
import type { GeoreferenceSeedReply } from '../../../src/world/georef-client.ts'
import { buildGeoreference } from '../../../src/world/georef.ts'
import type { Project, ProjectGeoreference } from '../../../src/world/types.ts'

const NOW = new Date('2026-11-17T12:00:00.000Z')
const PROJECT = {
  spatialFrame: { version: 1, createdAt: '2026-11-16T08:00:00.000Z', method: 'two-point-ground', landmark: { x: 0, y: 0, z: 0 }, headingMarker: { x: 0, y: 0, z: 2 }, separationM: 2, toleranceM: 0.15, anchorBearingDeg: null, frameId: 'frame-a' },
} as unknown as Project

const SEED: GeoreferenceSeedReply = {
  bearing: { deg: 31.5, spreadDeg: 4.25, sigmaDeg: 15, scans: 3, lowConfidence: false },
  origin: { lat: 51.50071234, lng: -0.12461234, accuracyM: 10 },
  declination: { deg: 1.2, model: 'WMM2025', year: 2026.88 },
  considered: 5,
  used: 3,
}

function typed(extra: Partial<FormState['values']> = {}): FormState {
  return { values: { ...startingValues(), lat: '51.5007', lng: '-0.1246', heading: '30', ...extra }, seed: null }
}

test('what is a number: a comma decimal, a unicode minus and spaces are, text and half numbers are not', () => {
  assert.equal(parseNumber('51.5007'), 51.5007)
  assert.equal(parseNumber(' -0.1246 '), -0.1246)
  assert.equal(parseNumber('51,5007'), 51.5007, 'a comma as the decimal point')
  assert.equal(parseNumber('−0.1246'), -0.1246, 'a minus sign as a keyboard types it')
  assert.equal(parseNumber('.5'), 0.5)
  assert.equal(parseNumber('3.'), 3)
  assert.equal(parseNumber('1 000'), 1000)
  for (const bad of ['', '   ', 'abc', '51.5.7', '--3', '1e3', '1,234,5', '5 m', 'NaN', 'Infinity', '0x10', '+']) assert.equal(parseNumber(bad), null, JSON.stringify(bad))
})

test('typed numbers make a record that is approximate until Confirm, and the record says what it was made against', () => {
  const approximate = buildFromForm(typed(), PROJECT, NOW, false)
  assert.ok(approximate.ok)
  assert.equal(approximate.source, 'typed')
  assert.equal(approximate.georeference.confirmedAt, undefined, 'a save is not a confirmation')
  assert.equal(Object.hasOwn(approximate.georeference, 'confirmedAt'), false)
  assert.equal(approximate.georeference.source, 'typed')
  assert.deepEqual(approximate.georeference.origin, { lat: 51.5007, lng: -0.1246, altitudeM: null, accuracyM: 3.5 })
  assert.equal(approximate.georeference.heightDatum, 'unknown', 'a typed location has no height, and says so')
  assert.equal(approximate.georeference.bearingDeg, 30)
  assert.equal(approximate.georeference.bearingAccuracyDeg, TYPED_HEADING_ACCURACY_DEFAULT_DEG)
  assert.equal(approximate.georeference.anchorRef, 'frame-a', 'made against the frame the Place holds')
  assert.equal(approximate.georeference.registeredAt, '2026-11-17T12:00:00.000Z')

  const confirmed = buildFromForm(typed(), PROJECT, NOW, true)
  assert.ok(confirmed.ok)
  assert.equal(confirmed.georeference.confirmedAt, '2026-11-17T12:00:00.000Z')
  // Nothing else differs: confirming is saying so, not changing the numbers.
  assert.deepEqual({ ...confirmed.georeference, confirmedAt: undefined }, { ...approximate.georeference, confirmedAt: undefined })

  // A Place with no frame, or a frame with no id, binds to nothing.
  assert.equal((buildFromForm(typed(), null, NOW, false) as { georeference: ProjectGeoreference }).georeference.anchorRef, null)
  const legacyFrame = { spatialFrame: { ...PROJECT.spatialFrame, frameId: undefined } } as unknown as Project
  assert.equal((buildFromForm(typed(), legacyFrame, NOW, false) as { georeference: ProjectGeoreference }).georeference.anchorRef, null)
})

test('a field that is empty or not a number is said to be, in words, and nothing is guessed', () => {
  const empty = buildFromForm({ values: startingValues(), seed: null }, PROJECT, NOW, false)
  assert.ok(!empty.ok)
  assert.deepEqual(empty.reasons, ['Latitude is empty.', 'Longitude is empty.', 'Heading is empty.'])
  const wrong = buildFromForm(typed({ lat: 'north', heading: '', originAccuracyM: '3,5m' }), PROJECT, NOW, false)
  assert.ok(!wrong.ok)
  assert.ok(wrong.reasons.includes('Latitude is not a number.'))
  assert.ok(wrong.reasons.includes('Heading is empty.'))
  assert.ok(wrong.reasons.includes('Location accuracy is not a number.'))
  // Out of range.
  for (const [values, reason] of [
    [{ lat: '91' }, 'Latitude must be from -90 to 90.'],
    [{ lat: '-90' }, 'Latitude must be from -90 to 90.'],
    [{ lng: '181' }, 'Longitude must be from -180 to 180.'],
    [{ heading: '400' }, 'Heading must be from -360 to 360 degrees.'],
  ] as const) {
    const bad = buildFromForm(typed(values), PROJECT, NOW, false)
    assert.ok(!bad.ok)
    assert.ok(bad.reasons.includes(reason), `${JSON.stringify(values)}: ${bad.ok ? '' : bad.reasons.join(' | ')}`)
  }
  // The heading is folded into [0, 360): -10 is 350, and 360 is 0.
  assert.equal((buildFromForm(typed({ heading: '-10' }), PROJECT, NOW, false) as { georeference: ProjectGeoreference }).georeference.bearingDeg, 350)
  assert.equal((buildFromForm(typed({ heading: '360' }), PROJECT, NOW, false) as { georeference: ProjectGeoreference }).georeference.bearingDeg, 0)
  // The antimeridian, the equator and the prime meridian are places.
  assert.ok(buildFromForm(typed({ lat: '-16.5', lng: '180' }), PROJECT, NOW, false).ok)
  assert.ok(buildFromForm(typed({ lat: '0', lng: '36.8' }), PROJECT, NOW, false).ok)
  // And (0, 0) is how a missing location is written, so the server's own rule refuses it here too.
  const nowhere = buildFromForm(typed({ lat: '0', lng: '0' }), PROJECT, NOW, false)
  assert.ok(!nowhere.ok)
  assert.ok(nowhere.reasons.some((r) => r.includes('latitude 0 and longitude 0')))
})

test('typed numbers cannot claim better than a map click, in words, and at the edge they can', () => {
  const atFloor = buildFromForm(typed({ originAccuracyM: '3.5', headingAccuracyDeg: '1' }), PROJECT, NOW, false)
  assert.ok(atFloor.ok)
  const tighterLocation = buildFromForm(typed({ originAccuracyM: '3.4' }), PROJECT, NOW, false)
  assert.ok(!tighterLocation.ok)
  assert.deepEqual(tighterLocation.reasons, ['Location accuracy cannot be better than 3.5 m: a map click is no better than that.'])
  const tighterHeading = buildFromForm(typed({ headingAccuracyDeg: '0.5' }), PROJECT, NOW, false)
  assert.ok(!tighterHeading.ok)
  assert.deepEqual(tighterHeading.reasons, ['Heading accuracy cannot be better than 1 degrees: a long building edge gives about that.'])
  // A claim of any size above it is fine, and a larger number is simply a less sure one.
  assert.ok(buildFromForm(typed({ originAccuracyM: '40', headingAccuracyDeg: '90' }), PROJECT, NOW, false).ok)
  assert.ok(!buildFromForm(typed({ originAccuracyM: '0' }), PROJECT, NOW, false).ok)
})

test('the compass estimate fills the form and changes nothing else: it is a seed, approximate, and never confirmed by being one', () => {
  const filled = applyEstimate(startingValues(), SEED)!
  assert.equal(filled.values.heading, '31.5')
  assert.equal(filled.values.headingAccuracyDeg, '15')
  assert.equal(filled.values.lat, '51.50071234')
  assert.equal(filled.values.lng, '-0.12461234')
  assert.equal(filled.values.originAccuracyM, '10')
  assert.equal(sourceOf(filled), 'gps-compass')

  const approximate = buildFromForm(filled, PROJECT, NOW, false)
  assert.ok(approximate.ok)
  assert.equal(approximate.georeference.source, 'gps-compass')
  assert.equal(approximate.georeference.confirmedAt, undefined, 'an estimate is not confirmed by being one')
  assert.deepEqual(approximate.georeference.declination, { deg: 1.2, model: 'WMM2025', year: 2026.88 }, 'the declination the scans were corrected by is kept')
  assert.deepEqual(approximate.georeference.seed, { scans: 3, spreadDeg: 4.25, lowConfidence: false, fromSeed: true }, 'and what it rests on, for audit')
  // Only a person pressing Confirm confirms it.
  const confirmed = buildFromForm(filled, PROJECT, NOW, true)
  assert.ok(confirmed.ok)
  assert.equal(confirmed.georeference.confirmedAt, '2026-11-17T12:00:00.000Z')

  // A seed cannot claim better than a compass: 10 m and 15 degrees at the best.
  const tight = buildFromForm({ ...filled, values: { ...filled.values, headingAccuracyDeg: '14' } }, PROJECT, NOW, false)
  assert.ok(!tight.ok)
  assert.deepEqual(tight.reasons, ['Heading accuracy cannot be better than 15 degrees.'])
  const loose = buildFromForm({ ...filled, values: { ...filled.values, originAccuracyM: '9' } }, PROJECT, NOW, false)
  assert.ok(!loose.ok)
  assert.deepEqual(loose.reasons, ['Location accuracy cannot be better than 10 m.'])

  // An estimate with no bearing fills nothing, and one with no landmark fills the heading and leaves the location to the person.
  assert.equal(applyEstimate(startingValues(), { ...SEED, bearing: null }), null)
  const headingOnly = applyEstimate({ ...startingValues(), lat: '51.5', lng: '-0.12' }, { ...SEED, origin: null })!
  assert.equal(headingOnly.values.lat, '51.5')
  assert.equal(headingOnly.values.lng, '-0.12')
  assert.equal(headingOnly.values.heading, '31.5')
  assert.equal(sourceOf(headingOnly), 'typed', 'a heading from the compass and a location from the person is the person\'s record')
})

test('an estimate the person edits is their numbers: typed, claiming what typed numbers can', () => {
  const filled = applyEstimate(startingValues(), SEED)!
  for (const field of ['lat', 'lng', 'heading'] as const) {
    const edited: FormState = { ...filled, values: { ...filled.values, [field]: '12.3' } }
    assert.equal(sourceOf(edited), 'typed', field)
  }
  // Editing an accuracy does not change where the numbers came from.
  assert.equal(sourceOf({ ...filled, values: { ...filled.values, originAccuracyM: '50' } }), 'gps-compass')
  // An edited estimate may then claim what typed numbers can, and no more: 3.5 m, but its own 15 degrees stays as the person left it.
  const edited: FormState = { ...filled, values: { ...filled.values, lat: '51.5008', originAccuracyM: '3.5' } }
  const built = buildFromForm(edited, PROJECT, NOW, false)
  assert.ok(built.ok)
  assert.equal(built.georeference.source, 'typed')
  assert.equal(Object.hasOwn(built.georeference, 'declination'), false, 'it is not a compass seed any more, so it carries no declination of one')
  assert.equal(built.georeference.seed?.['fromSeed'], false, 'but the estimate it began as is recorded')
})

test('saving again keeps what the saved record knew: a seed confirmed unedited stays a seed, a map click stays one, and a height stays with its spot', () => {
  // A compass seed saved as approximate, from the estimate.
  const first = buildFromForm(applyEstimate(startingValues(), SEED)!, PROJECT, NOW, false)
  assert.ok(first.ok)
  const saved: ProjectGeoreference = first.georeference
  assert.equal(saved.source, 'gps-compass')
  assert.equal(saved.confirmedAt, undefined)

  // Opened again the form holds its numbers and no estimate, and Confirm confirms a seed: still from the compass, with the accuracy it claimed.
  const reopened: FormState = { values: valuesFromRecord(saved), seed: null }
  const holding = { ...PROJECT, georeference: saved } as Project
  const later = new Date('2026-11-18T09:00:00.000Z')
  const confirm = buildFromForm(reopened, holding, later, true)
  assert.ok(confirm.ok)
  assert.equal(confirm.source, 'gps-compass')
  assert.equal(confirm.georeference.source, 'gps-compass')
  assert.equal(confirm.georeference.confirmedAt, later.toISOString())
  assert.deepEqual(confirm.georeference.declination, saved.declination)
  assert.deepEqual(confirm.georeference.seed, saved.seed)
  assert.equal(confirm.georeference.bearingAccuracyDeg, saved.bearingAccuracyDeg, 'confirming does not improve the claim')
  assert.equal(confirm.georeference.origin.accuracyM, saved.origin.accuracyM)

  // A number the person changed is theirs: typed, with no seed provenance.
  const edited = buildFromForm({ values: { ...reopened.values, heading: '33' }, seed: null }, holding, later, true)
  assert.ok(edited.ok)
  assert.equal(edited.georeference.source, 'typed')
  assert.equal(Object.hasOwn(edited.georeference, 'declination'), false)
  assert.equal(Object.hasOwn(edited.georeference, 'seed'), false)

  // A fresh estimate is its own record: none of the saved one's provenance rides along.
  const fresh: GeoreferenceSeedReply = { ...SEED, bearing: { ...SEED.bearing!, deg: 77 }, declination: { deg: -2.5, model: 'WMM2025', year: 2026.99 } }
  const replaced = buildFromForm(applyEstimate(reopened.values, fresh)!, holding, later, false)
  assert.ok(replaced.ok)
  assert.deepEqual(replaced.georeference.declination, fresh.declination)
  assert.equal(replaced.georeference.bearingDeg, 77)

  // A record from the map keeps being one when saved as it stands, and the button alone decides whether it is confirmed.
  const plain: ProjectGeoreference = { ...saved }
  delete plain.declination
  delete plain.seed
  const clicked: ProjectGeoreference = { ...plain, source: 'map-click', origin: { ...saved.origin, accuracyM: 4, altitudeM: 41.25 }, heightDatum: 'ellipsoid', bearingAccuracyDeg: 2, confirmedAt: '2026-11-17T10:05:00.000Z' }
  const onTheMap = { ...PROJECT, georeference: clicked } as Project
  const demoted = buildFromForm({ values: valuesFromRecord(clicked), seed: null }, onTheMap, later, false)
  assert.ok(demoted.ok)
  assert.equal(demoted.georeference.source, 'map-click', 'saving a map click as approximate does not make it a typed number')
  assert.equal(demoted.georeference.confirmedAt, undefined, 'and the button said approximate')
  assert.equal(Object.hasOwn(demoted.georeference, 'declination'), false)
  assert.equal(Object.hasOwn(demoted.georeference, 'seed'), false)
  // A height the record holds stays while the spot does, and goes when the person moves the spot.
  assert.equal(demoted.georeference.origin.altitudeM, 41.25)
  assert.equal(demoted.georeference.heightDatum, 'ellipsoid')
  const moved = buildFromForm({ values: { ...valuesFromRecord(clicked), lat: '51.6' }, seed: null }, onTheMap, later, true)
  assert.ok(moved.ok)
  assert.equal(moved.georeference.source, 'typed', 'a changed number is the person\'s')
  assert.equal(moved.georeference.origin.altitudeM, null)
  assert.equal(moved.georeference.heightDatum, 'unknown')
  // And a Place with no record keeps nothing.
  const none = buildFromForm({ values: valuesFromRecord(clicked), seed: null }, PROJECT, later, true)
  assert.ok(none.ok)
  assert.equal(none.georeference.source, 'typed')
  assert.equal(none.georeference.origin.altitudeM, null)
})

test('the form starts from the record a Place holds, or from the accuracies typed numbers may claim', () => {
  const start = startingValues()
  assert.deepEqual(start, { lat: '', lng: '', heading: '', originAccuracyM: '3.5', headingAccuracyDeg: '5' })
  const record: ProjectGeoreference = {
    origin: { lat: 51.500712345, lng: -0.12461, altitudeM: null, accuracyM: 3.5 },
    heightDatum: 'unknown',
    bearingDeg: 30.25,
    bearingAccuracyDeg: 1.5,
    convention: 2,
    datum: 'WGS84',
    source: 'map-click',
    registeredAt: '2026-11-17T10:00:00.000Z',
    confirmedAt: '2026-11-17T10:00:00.000Z',
    anchorRef: null,
  }
  assert.deepEqual(valuesFromRecord(record), { lat: '51.500712345', lng: '-0.12461', heading: '30.25', originAccuracyM: '3.5', headingAccuracyDeg: '1.5' })
  assert.deepEqual(valuesFromRecord(null), { lat: '', lng: '', heading: '', originAccuracyM: '', headingAccuracyDeg: '' })
  // The record the form shows comes back out of it unchanged.
  const roundTrip = buildFromForm({ values: valuesFromRecord(record), seed: null }, null, NOW, true)
  assert.ok(roundTrip.ok)
  assert.deepEqual(roundTrip.georeference.origin, record.origin)
  assert.equal(roundTrip.georeference.bearingDeg, 30.25)
})

test('the words: what a saved record says about itself, what the form is about to claim, and what the estimate rests on', () => {
  assert.equal(savedStatusText(null), NO_LOCATION_TEXT)
  assert.equal(savedStatusText(undefined), NO_LOCATION_TEXT)
  const base = { origin: { lat: 1, lng: 2, altitudeM: null, accuracyM: 3.5 }, heightDatum: 'unknown', bearingDeg: 1, bearingAccuracyDeg: 1, convention: 2, datum: 'WGS84', source: 'map-click', registeredAt: '2026-11-17T10:00:00.000Z', anchorRef: null } as ProjectGeoreference
  assert.equal(savedStatusText(base), SAVED_APPROXIMATE_TEXT)
  assert.equal(savedStatusText({ ...base, confirmedAt: '2026-11-17T10:05:00.000Z' }), 'Saved and confirmed 2026-11-17 10:05 UTC.')
  assert.equal(savedStatusText({ ...base, confirmedAt: 'not a time' }), 'Saved and confirmed.')

  assert.equal(claimText(typed()), 'Location approximate to about 3.5 m · heading about 5 degrees')
  assert.equal(claimText(typed({ originAccuracyM: '25', headingAccuracyDeg: '12' })), 'Location approximate to about 25 m · heading about 12 degrees')
  assert.equal(claimText(typed({ originAccuracyM: '', headingAccuracyDeg: 'x' })), 'Location accuracy not set · heading accuracy not set')

  assert.equal(useEstimateLabel(1), 'Use compass estimate from 1 scan')
  assert.equal(useEstimateLabel(3), 'Use compass estimate from 3 scans')
  assert.deepEqual(estimateText(null), [])
  assert.deepEqual(estimateText({ ...SEED, bearing: null }), [])
  assert.deepEqual(estimateText(SEED), [COMPASS_CAVEAT, '3 scans agree to about 4 degrees.'])
  const rough = estimateText({ ...SEED, bearing: { ...SEED.bearing!, scans: 2, lowConfidence: true, spreadDeg: 41 }, origin: null })
  assert.deepEqual(rough, [COMPASS_CAVEAT, 'Only 2 scans, or readings that disagree by about 41 degrees: a rough guess.', 'No scan recorded where the camera was at its GPS fix, so type the location.'])
  assert.match(estimateText({ ...SEED, bearing: { ...SEED.bearing!, scans: 1, lowConfidence: true } })[1]!, /^Only 1 scan,/)
})

test('a record made for an earlier frame of the Place says so, and one that says nothing about it does not', () => {
  const georeference = (anchorRef: string | null) => ({ georeference: { anchorRef } as ProjectGeoreference, spatialFrame: PROJECT.spatialFrame })
  assert.equal(isEarlierFrame(georeference('frame-b')), true)
  assert.equal(isEarlierFrame(georeference('frame-a')), false)
  assert.equal(isEarlierFrame(georeference(null)), false)
  assert.equal(isEarlierFrame(null), false)
  assert.match(EARLIER_FRAME_TEXT, /earlier alignment/)
})

test('every word is plain, and none claims more than was measured', () => {
  const words = [
    PANEL_TITLE, PANEL_HINT, HEADING_LABEL, SAVE_APPROXIMATE_LABEL, CONFIRM_LABEL, NO_ESTIMATE_LABEL, NO_LOCATION_TEXT, SAVED_APPROXIMATE_TEXT,
    EARLIER_FRAME_TEXT, COMPASS_CAVEAT, REPLACES_CONFIRMED_TEXT, OLD_SCANS_TEXT, SAVED_APPROXIMATE_MESSAGE, CONFIRMED_MESSAGE, useEstimateLabel(3), claimText(typed()),
    ...estimateText(SEED),
  ]
  for (const text of words) {
    assert.doesNotMatch(text, /verified|exact|precise|within|guarantee|accurate to|certain/i, text)
    assert.doesNotMatch(text, /!/, text)
  }
  // A seed is approximate in its own caveat, and an unconfirmed record says it is not confirmed.
  assert.match(COMPASS_CAVEAT, /^Approximate\./)
  assert.match(SAVED_APPROXIMATE_TEXT, /approximate, not confirmed/)
  assert.match(REPLACES_CONFIRMED_TEXT, /confirmed location with an estimate/)
  assert.match(OLD_SCANS_TEXT, /grid/)
  // A save does not say every scan was placed: the ones a person moved by hand stay where they are.
  assert.match(SAVED_APPROXIMATE_MESSAGE, /^Saved as approximate\./)
  assert.match(CONFIRMED_MESSAGE, /^Confirmed\./)
  for (const message of [SAVED_APPROXIMATE_MESSAGE, CONFIRMED_MESSAGE]) assert.match(message, /not moved by hand/, message)
})

test('lowering only the accuracy of a saved compass seed does not make it a typed number that claims what a map click can', () => {
  // A fresh estimate in the form: lowering only the accuracy is refused (it is the compass's number, and the floor is the compass's).
  const fresh = applyEstimate(startingValues(), SEED)!
  const refused = buildFromForm({ ...fresh, values: { ...fresh.values, originAccuracyM: '3.5', headingAccuracyDeg: '2' } }, PROJECT, NOW, true)
  assert.equal(refused.ok, false)

  // The seed saved as approximate, and the panel opened again (the form no longer holds the estimate it came from): the same edit.
  const saved = buildFromForm(fresh, PROJECT, NOW, false)
  assert.ok(saved.ok)
  const project = { ...PROJECT, georeference: saved.georeference } as Project
  const reopened: FormState = { values: valuesFromRecord(saved.georeference), seed: null }
  const again = buildFromForm({ ...reopened, values: { ...reopened.values, originAccuracyM: '3.5', headingAccuracyDeg: '2' } }, project, NOW, true)
  assert.equal(again.ok, false, 'the numbers are still the compass\'s, and a record of them claims what a compass can')
  assert.ok(!again.ok && again.reasons.some((reason) => /Location accuracy cannot be better than 10 m/.test(reason)), JSON.stringify(again))
  assert.ok(!again.ok && again.reasons.some((reason) => /Heading accuracy cannot be better than 15 degrees/.test(reason)), JSON.stringify(again))

  // Claiming less, which is always allowed, keeps it a compass seed with what it rested on.
  const more = buildFromForm({ ...reopened, values: { ...reopened.values, originAccuracyM: '40', headingAccuracyDeg: '30' } }, project, NOW, true)
  assert.ok(more.ok)
  assert.equal(more.georeference.source, 'gps-compass')
  assert.deepEqual(more.georeference.declination, saved.georeference.declination)
  assert.deepEqual(more.georeference.seed, saved.georeference.seed)
  assert.equal(more.georeference.origin.accuracyM, 40)
  assert.equal(more.georeference.bearingAccuracyDeg, 30)

  // Changing the heading is the person's own number, and claims what typed numbers can: that is the one way to a better claim.
  const theirs = buildFromForm({ ...reopened, values: { ...reopened.values, heading: '31.6', originAccuracyM: '3.5', headingAccuracyDeg: '2' } }, project, NOW, true)
  assert.ok(theirs.ok)
  assert.equal(theirs.georeference.source, 'typed')
})

test('a saved map click keeps its own floor when only its accuracy is edited: 1 degree, not the compass\'s 15, and not less than its own', () => {
  const click = buildGeoreference({ lat: 51.5, lng: -0.12, originAccuracyM: 3.5, bearingDeg: 40, bearingAccuracyDeg: 1, source: 'map-click', anchorRef: 'frame-a', now: NOW, confirmed: true })
  const project = { ...PROJECT, georeference: click } as Project
  const values = valuesFromRecord(click)
  assert.equal(buildFromForm({ seed: null, values: { ...values, headingAccuracyDeg: '0.5' } }, project, NOW, true).ok, false)
  const kept = buildFromForm({ seed: null, values: { ...values, headingAccuracyDeg: '2' } }, project, NOW, true)
  assert.ok(kept.ok)
  assert.equal(kept.georeference.source, 'map-click')
  assert.equal(kept.georeference.bearingAccuracyDeg, 2)
})
