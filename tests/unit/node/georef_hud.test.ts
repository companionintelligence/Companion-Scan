/**
 * The editor's location readout and the "Mirrored placement" flag (src/viewer/georef-hud.ts).
 *
 * What is pinned:
 *
 *  - a world with no georeference says "Local (no georeference)" and prints the point in the scene's own metres: no latitude, no
 *    longitude, no "ENU" (the readout of the build before this one printed all three from the wrong origin);
 *  - a georeferenced world says where the point is on Earth: at the landmark the latitude and longitude are the record's own, to a
 *    millimetre (not only to the six decimals printed), and 100 m east or north of it they are the 70-digit reference's
 *    (georef_reference.py, through georef_vectors.test.ts), with how sure that is as the record claims it and "not confirmed"
 *    until a person confirmed it;
 *  - the flag counts the scans of an older world (z north) that were placed by GPS and compass and not moved since, and nothing else:
 *    not a calibrated scan, not a moved one, not one on the grid, not a world of the right-handed scene.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/georef_hud.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EARLIER_ALIGNMENT_FLAG_TEXT, LOCAL_READOUT_LABEL, MIRRORED_FLAG_TEXT, mirroredPlacementCount, notInFrameText, placementFlagHtml, REPLACE_BY_GPS_LABEL, SET_AGAIN_LABEL, worldReadout, worldReadoutHtml } from '../../../src/viewer/georef-hud.ts'
import type { EditPatch, ProjectGeoreference, ScanManifest, WorldProject } from '../../../src/world/types.ts'

const RECORD: ProjectGeoreference = {
  origin: { lat: 51.5007, lng: -0.1246, altitudeM: 11, accuracyM: 3.5 },
  heightDatum: 'ellipsoid',
  bearingDeg: 30,
  bearingAccuracyDeg: 1,
  convention: 2,
  datum: 'WGS84',
  source: 'map-click',
  registeredAt: '2026-11-17T10:00:00.000Z',
  confirmedAt: '2026-11-17T10:00:00.000Z',
  anchorRef: null,
}

const frame = (z: 'north' | 'south') => ({ type: 'ENU_Y_UP' as const, origin: { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }, units: 'meters' as const, axes: { x: 'east' as const, y: 'up' as const, z } })
const georeferenced = (record = RECORD) => ({ georeference: record, localFrame: frame('south') })

const mm = (degrees: number, latitude: number) => degrees * (Math.PI / 180) * 6_378_137 * Math.cos(latitude * (Math.PI / 180)) * 1000

test('a world with no georeference says Local (no georeference) and prints the point in scene metres: no latitude, no longitude, no ENU', () => {
  for (const world of [{ localFrame: frame('north') }, { localFrame: frame('south') }, { localFrame: undefined as never }]) {
    const readout = worldReadout(world, { x: 1.2345, y: 0, z: -3.4 })
    assert.equal(readout.geographic, false)
    assert.equal(readout.position, undefined)
    assert.deepEqual(readout.lines, [LOCAL_READOUT_LABEL, '1.23, 0.00, -3.40 m'])
    assert.equal(LOCAL_READOUT_LABEL, 'Local (no georeference)')
    assert.doesNotMatch(readout.lines.join(' '), /ENU|GPS|lat|lng|°/i)
  }
  // A world that holds a georeference but is still declared z north is not in the scene the record defines: it is local.
  const inconsistent = worldReadout({ georeference: RECORD, localFrame: frame('north') }, { x: 0, y: 0, z: 0 })
  assert.equal(inconsistent.geographic, false)
  assert.equal(worldReadoutHtml({ localFrame: frame('north') }, { x: 0, y: 0, z: 0 }), 'Local (no georeference)<br>0.00, 0.00, 0.00 m')
  // A point that is not a number is not printed as one.
  assert.deepEqual(worldReadout({ localFrame: frame('south') }, { x: Number.NaN, y: 0, z: 0 }).lines[1], '--, 0.00, 0.00 m')
})

test('at the landmark the readout is the record\'s own latitude and longitude, to a millimetre, and a point 100 m east or north is the 70-digit reference\'s', () => {
  const world = georeferenced()
  const here = worldReadout(world, { x: 0, y: 0, z: 0 })
  assert.equal(here.geographic, true)
  assert.ok(Math.abs(mm(here.position!.lat - 51.5007, 51.5007)) < 1, 'latitude to a millimetre')
  assert.ok(Math.abs(mm(here.position!.lng - -0.1246, 51.5007)) < 1, 'longitude to a millimetre')
  assert.equal(here.lines[0], 'East 0.00 · North 0.00 · Up 0.00 m')
  assert.equal(here.lines[1], '51.500700, -0.124600')

  // 100 m east is scene +x; 100 m north is scene -z (z is south). The reference is from the London origin at 11 m: R6 T5.
  const east = worldReadout(world, { x: 100, y: 0, z: 0 })
  assert.ok(Math.abs(east.position!.lat - 5.15006999911598929572e+1) < 1e-10 && Math.abs(east.position!.lng - -1.23159898965888225143e-1) < 1e-10)
  assert.equal(east.lines[0], 'East 100.00 · North 0.00 · Up 0.00 m')
  const north = worldReadout(world, { x: 0, y: 0, z: -100 })
  assert.ok(Math.abs(north.position!.lat - 5.15015988113865568322e+1) < 1e-10 && Math.abs(north.position!.lng - -1.24600000000000000000e-1) < 1e-10)
  assert.equal(north.lines[0], 'East 0.00 · North 100.00 · Up 0.00 m')
  // Up is up: a scene y of 2 is 2 m up and changes neither the latitude nor the longitude.
  const up = worldReadout(world, { x: 0, y: 2, z: 0 })
  assert.equal(up.lines[0], 'East 0.00 · North 0.00 · Up 2.00 m')
  assert.ok(Math.abs(up.position!.lat - 51.5007) < 1e-9)
})

test('the readout says how sure the record is, as the record claims it, and "not confirmed" until a person confirmed it', () => {
  const confirmed = worldReadout(georeferenced(), { x: 0, y: 0, z: 0 }).lines[2]
  assert.equal(confirmed, 'Approximate to about 3.5 m')
  // Farther from the landmark the bearing's error adds: 1 degree at 50 m is 0.87 m.
  const far = worldReadout(georeferenced(), { x: 0, y: 0, z: -50 }).lines[2]
  assert.equal(far, 'Approximate to about 3.6 m')
  const seed: ProjectGeoreference = { ...RECORD, source: 'gps-compass', bearingAccuracyDeg: 25, origin: { ...RECORD.origin, accuracyM: 25 }, confirmedAt: undefined }
  assert.equal(worldReadout(georeferenced(seed), { x: 0, y: 0, z: 0 }).lines[2], 'Approximate to about 25 m · not confirmed')
  // 40 m from the landmark a bearing sigma of 25 degrees is 17 m sideways, on top of the 25 m: sqrt(25^2 + 17.5^2) is about 30 m.
  assert.equal(worldReadout(georeferenced(seed), { x: 0, y: 0, z: -40 }).lines[2], `Approximate to about ${Math.round(Math.hypot(25, 40 * 25 * (Math.PI / 180)))} m · not confirmed`)
  assert.equal(Math.round(Math.hypot(25, 40 * 25 * (Math.PI / 180))), 30)
  for (const line of [confirmed, far]) assert.doesNotMatch(line, /verified|within|exact|accurate/i)
  // The HTML is the lines joined, with no user text in it to escape.
  assert.equal(worldReadoutHtml(georeferenced(), { x: 0, y: 0, z: 0 }), worldReadout(georeferenced(), { x: 0, y: 0, z: 0 }).lines.join('<br>'))
})

function scan(name: string, extra: Partial<ScanManifest> = {}): ScanManifest {
  return {
    scanId: `scan-${name}`,
    projectId: 'proj-1',
    sessionId: null,
    filename: `${name}.glb`,
    name,
    glbUrl: `/scans/${name}.glb`,
    geoPose: { lat: 51.5, lng: -0.12, altitudeM: null, bearing: 10, accuracyM: 6 },
    localToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    accuracyM: 6,
    geoDistanceM: 12,
    capturedAt: null,
    pointCount: null,
    detectionCount: null,
    layerIndex: [],
    status: 'ready',
    ...extra,
  }
}

const patch = (scanId: string): EditPatch => ({
  patchId: `p-${scanId}`,
  worldId: 'w',
  scanId,
  targetId: `${scanId}.glb`,
  scope: 'scan',
  transform: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 5, 1], position: { x: 5, y: 0, z: 5 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
  actorId: 'a',
  createdAt: '2026-11-17T10:00:00.000Z',
})

function legacy(scans: ScanManifest[], editPatches: EditPatch[] = [], z: 'north' | 'south' = 'north'): Pick<WorldProject, 'localFrame' | 'scans' | 'editPatches'> {
  return { localFrame: frame(z), scans, editPatches }
}

test('the flag counts the GPS-placed scans of an older world that nobody moved, and only those', () => {
  const calibrated = scan('calibrated', { calibrationMethod: 'two-point-ground', calibrationStatus: 'verified' })
  const uncalibratedRow = scan('uncalibrated-row', { calibrationStatus: 'uncalibrated' })
  const stamped = scan('stamped', { placementSource: 'gps-compass' })
  const grid = scan('grid', { placementSource: 'grid', geoDistanceM: 3 })
  const outlier = scan('outlier', { geoOutlier: true, geoDistanceM: 300 })
  const noFix = scan('no-fix', { geoPose: { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }, geoDistanceM: null })
  const moved = scan('moved')
  const world = legacy([calibrated, uncalibratedRow, stamped, grid, outlier, noFix, moved], [patch(moved.scanId)])
  // The uncalibrated GPS-placed row and the stamped one; not the calibrated, grid, outlier, no-fix or hand-moved ones.
  assert.equal(mirroredPlacementCount(world), 2)
  assert.equal(mirroredPlacementCount(legacy([], [])), 0)
  // A world of the right-handed scene has none, whatever its scans.
  assert.equal(mirroredPlacementCount(legacy([stamped, uncalibratedRow], [], 'south')), 0)
  // A move that was undone leaves the scan where its calibration put it: it counts again as a GPS scan.
  const undo: EditPatch = { ...patch(moved.scanId), patchId: 'u', revertsPatchId: `p-${moved.scanId}` }
  assert.equal(mirroredPlacementCount(legacy([moved], [patch(moved.scanId), undo])), 1)
})

test('the flag says what is wrong, offers Re-place by GPS only where a Place can be given a location, and prints no user text', () => {
  const world = legacy([scan('a'), scan('b', { placementSource: 'gps-compass' })])
  const withPlace = placementFlagHtml(world, true)
  assert.match(withPlace, new RegExp(`${MIRRORED_FLAG_TEXT}: 2 scans`))
  assert.match(withPlace, /data-action="replace-by-gps"[^>]*>Re-place by GPS<\/button>/)
  assert.equal(REPLACE_BY_GPS_LABEL, 'Re-place by GPS')
  assert.match(withPlace, /flipped east to west/)
  assert.match(withPlace, /Nothing has moved them/)
  assert.match(withPlace, /Setting the Place&#39;s location|Setting the Place's location/)
  // No Place (the legacy default world): the flag, and no action it cannot do.
  const noPlace = placementFlagHtml(world, false)
  assert.match(noPlace, /Mirrored placement: 2 scans/)
  assert.doesNotMatch(noPlace, /button/)
  assert.match(noPlace, /Choose a Place to set its location/)
  // One scan reads in the singular.
  const one = placementFlagHtml(legacy([scan('a')]), true)
  assert.match(one, /Mirrored placement: 1 scan</)
  assert.match(one, /1 scan in this world was placed/)
  assert.match(one, /it is flipped/)
  // Nothing to flag: nothing.
  assert.equal(placementFlagHtml(legacy([scan('c', { calibrationMethod: 'two-point-ground', calibrationStatus: 'verified' })]), true), '')
  assert.equal(placementFlagHtml(legacy([scan('a')], [], 'south'), true), '')
  // A scan name is never in the markup.
  assert.doesNotMatch(placementFlagHtml(legacy([scan('<img src=x onerror=alert(1)>')]), true), /<img/)
})

const flagRow = (name: string, source: ScanManifest['placementSource'], extra: Partial<ScanManifest> = {}): ScanManifest => ({
  scanId: `scan-${name}`,
  projectId: 'proj-1',
  sessionId: null,
  filename: `${name}.glb`,
  name,
  glbUrl: `/scans/${name}.glb`,
  geoPose: { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null },
  localToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  accuracyM: null,
  geoDistanceM: null,
  capturedAt: null,
  pointCount: null,
  detectionCount: null,
  layerIndex: [],
  status: 'ready',
  ...(source ? { placementSource: source } : {}),
  ...extra,
})

test('a legacy scan reset to its calibration is still a mirrored placement, and one a person left somewhere else is not', () => {
  const legacy = (scans: ScanManifest[], editPatches: EditPatch[]) => ({ localFrame: frame('north'), editPatches, scans })
  const at = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]
  const byGps = (name: string, extra: Partial<ScanManifest>) => flagRow(name, 'gps-compass', { geoPose: { lat: 51.5, lng: -0.12, altitudeM: null, bearing: null, accuracyM: 5 }, geoDistanceM: 12, ...extra })
  const patch = (patchId: string, scanId: string, x: number): EditPatch => ({ patchId, worldId: 'w', scanId, targetId: `${scanId}.glb`, scope: 'scan', transform: { matrix: at(x), position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } }, createdAt: '2026-11-17T09:00:00.000Z' })
  // The scan was placed at x = 1 by the previous build, a person moved it to 5 and then reset it: it is at x = 1 again, mirrored as before.
  const reset = byGps('reset', { localToWorld: at(1), calibratedLocalToWorld: at(1) })
  const moved = byGps('moved', { localToWorld: at(5), calibratedLocalToWorld: at(1) })
  const patches = [patch('p1', reset.scanId, 5), patch('p2', reset.scanId, 1), patch('p3', moved.scanId, 5)]
  assert.equal(mirroredPlacementCount(legacy([reset], patches)), 1, 'reset to calibrated: nobody placed it')
  assert.equal(mirroredPlacementCount(legacy([moved], patches)), 0, 'a person left it somewhere else')
  assert.equal(mirroredPlacementCount(legacy([reset, moved], patches)), 1)
  // An older row with no stored first placement cannot be shown to be at it: with a move that counts, a person placed it, as it always was read.
  assert.equal(mirroredPlacementCount(legacy([byGps('old', { localToWorld: at(5) })], [patch('p4', 'scan-old', 5)])), 0)
})

test('a mixed Place says how many scans are not in its frame, in words that say what follows from it; a Place that is not mixed says nothing', () => {
  const mixed = { localFrame: frame('south'), editPatches: [], scans: [flagRow('cal', 'georeference'), flagRow('gps', 'gps-compass'), flagRow('grid', 'grid')] }
  const html = placementFlagHtml(mixed, true)
  assert.match(html, /data-flag="not-in-frame"/)
  assert.ok(html.includes(notInFrameText(2)))
  assert.equal(notInFrameText(2), 'Not in the Place frame: 2 scans')
  assert.equal(notInFrameText(1), 'Not in the Place frame: 1 scan')
  assert.match(html, /left out of matching things between scans until they are calibrated/)
  assert.doesNotMatch(html, new RegExp(REPLACE_BY_GPS_LABEL), 'a scene world has nothing mirrored to re-place')
  // One that is outside, said in the singular.
  const one = placementFlagHtml({ ...mixed, scans: [flagRow('cal', 'place-frame'), flagRow('gps', 'gps-compass')] }, false)
  assert.ok(one.includes(notInFrameText(1)))
  assert.match(one, /It is left out of matching things between scans until it is calibrated/)
  // Not mixed: no scan in the frame, so nothing to be outside of. No stamps: nothing is said.
  assert.equal(placementFlagHtml({ ...mixed, scans: [flagRow('gps', 'gps-compass'), flagRow('grid', 'grid')] }, true), '')
  assert.equal(placementFlagHtml({ ...mixed, scans: [flagRow('cal', 'georeference'), flagRow('old', undefined)] }, true), '')
  // A scan a person placed is where they put it, and is not counted.
  const patch: EditPatch = { patchId: 'p1', worldId: 'w', scanId: 'scan-gps', targetId: 'gps.glb', scope: 'scan', transform: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1], position: { x: 5, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } }, createdAt: '2026-11-17T10:00:00.000Z' }
  const moved = { localFrame: frame('south'), editPatches: [patch], scans: [flagRow('cal', 'georeference'), flagRow('gps', 'gps-compass', { localToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1], calibratedLocalToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })] }
  assert.equal(placementFlagHtml(moved, true), '')
})

test('a legacy world can carry both flags at once: the mirrored one with its action, and the mixed one', () => {
  const legacy = { localFrame: frame('north'), editPatches: [], scans: [flagRow('cal', 'place-frame', { calibrationMethod: 'two-point-ground', calibrationStatus: 'verified' }), flagRow('gps', 'gps-compass', { geoPose: { lat: 51.5, lng: -0.12, altitudeM: null, bearing: null, accuracyM: 5 }, geoDistanceM: 12 })] }
  const html = placementFlagHtml(legacy, true)
  assert.ok(html.includes(`${MIRRORED_FLAG_TEXT}: 1 scan`))
  assert.ok(html.includes(REPLACE_BY_GPS_LABEL))
  assert.ok(html.includes(notInFrameText(1)))
})

test('a Place whose location is for an earlier alignment says so where the world reads Local, and offers to set it again', () => {
  const world = { localFrame: frame('south'), editPatches: [], scans: [flagRow('cal', 'place-frame')] }
  // The world does not use that location: it reads Local. The flag says why, and the action opens the panel (the same hook as Re-place by GPS).
  const html = placementFlagHtml(world, true, { earlierAlignment: true })
  assert.match(html, /data-flag="earlier-alignment"/)
  assert.ok(html.includes(EARLIER_ALIGNMENT_FLAG_TEXT))
  assert.equal(EARLIER_ALIGNMENT_FLAG_TEXT, 'Location is for an earlier alignment')
  assert.ok(html.includes(`data-action="replace-by-gps">${SET_AGAIN_LABEL}</button>`))
  assert.equal(SET_AGAIN_LABEL, 'Set location again')
  assert.match(html, /does not use it/)
  assert.doesNotMatch(html, /verified|exact|within/i)
  // Without a Place to save for (the legacy default world) it says what is wrong and offers nothing it cannot do.
  const noPlace = placementFlagHtml(world, false, { earlierAlignment: true })
  assert.ok(noPlace.includes(EARLIER_ALIGNMENT_FLAG_TEXT))
  assert.doesNotMatch(noPlace, /<button/)
  // Not asked for, or asked for as false: nothing is said.
  assert.equal(placementFlagHtml(world, true), '')
  assert.equal(placementFlagHtml(world, true, {}), '')
  assert.equal(placementFlagHtml(world, true, { earlierAlignment: false }), '')
  // It sits beside the other flags, and does not hide them.
  const legacy = { localFrame: frame('north'), editPatches: [], scans: [flagRow('gps', 'gps-compass', { geoPose: { lat: 51.5, lng: -0.12, altitudeM: null, bearing: null, accuracyM: 5 }, geoDistanceM: 12 })] }
  const both = placementFlagHtml(legacy, true, { earlierAlignment: true })
  assert.ok(both.includes(`${MIRRORED_FLAG_TEXT}: 1 scan`) && both.includes(EARLIER_ALIGNMENT_FLAG_TEXT))
})
