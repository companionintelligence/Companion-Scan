/**
 * The editor's calibration pins in a georeferenced Place (src/world/anchor-placement.ts `sessionAnchorPositions`, src/world/georef.ts
 * `placeFrameToScene`, `placeFrameToSceneFor` and `sessionToProjectOfPlacement`).
 *
 * A calibrated scan's `calibratedLocalToWorld` is its session-to-project matrix M. Once the Place has a georeference it is the
 * georeference's turn times M, `Ry(180 - bearing) x M`, and the heading marker the pins show is a Place-frame point (0, 0, separation):
 * read through the placement without the turn it is drawn at `inverse(M) x inverse(Ry) x (0, 0, d)`, the point the turn carries away
 * from the tap about the landmark: it is out by the chord `2 d sin(delta / 2)` of the turn `delta = 180 - bearing`, up to twice the
 * baseline (5.6 m for the 2.8 m baseline of these taps). What is pinned:
 *
 *  - with the turn taken off the placement, the pins' positions in the scan's own coordinates are the taps, for every bearing, to 1e-9 m,
 *    and read from the placement as it is the heading marker is not (so this test can tell the bug it is about);
 *  - the turn is `Ry(180 - bearing)`, applied to a Place-frame point it is where the scene puts a point that far along the bearing;
 *  - the turn is asked for only where the placement holds it: a world with a georeference, and a scan in the Place's frame.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/georef_anchor_pins.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionAnchorPositions } from '../../../src/world/anchor-placement.ts'
import { sceneFromEnu } from '../../../src/world/enu.ts'
import { transformPoint, twoPointSeparationM, twoPointToProjectTransform } from '../../../src/world/geo.ts'
import { placeFrameToScene, placeFrameToSceneFor, sessionToProjectOfPlacement } from '../../../src/world/georef.ts'
import type { Vec3 } from '../../../src/world/types.ts'

/** Column-major 4x4 product `a x b`: `b` acts first. Written here so that the test shares no code with the server's. */
function multiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0)
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) out[column * 4 + row] += a[k * 4 + row]! * b[column * 4 + k]!
    }
  }
  return out
}

const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

const LANDMARK: Vec3 = { x: 1.5, y: -1.2, z: -0.4 }
const MARKER: Vec3 = { x: 3.1, y: -1.2, z: 1.9 }

test('with the georeference\'s turn taken off the placement the pins land on the two points the person tapped, for every bearing; read from the placement as it is the heading marker does not', () => {
  const m = twoPointToProjectTransform(LANDMARK, MARKER)
  const separation = twoPointSeparationM(LANDMARK, MARKER)
  let worstWithout = 0
  for (const bearing of [0, 17, 33, 90, 133.3, 180, 271, 359]) {
    const turn = placeFrameToScene({ bearingDeg: bearing })
    const calibrated = multiply(turn, m)
    const through = sessionAnchorPositions(sessionToProjectOfPlacement(calibrated, turn), separation)
    assert.ok(distance(through.landmark, LANDMARK) < 1e-9, `landmark, bearing ${bearing}`)
    assert.ok(distance(through.headingMarker!, MARKER) < 1e-9, `heading marker, bearing ${bearing}: ${JSON.stringify(through.headingMarker)}`)
    const without = sessionAnchorPositions(calibrated, separation)
    worstWithout = Math.max(worstWithout, distance(without.headingMarker!, MARKER))
    assert.ok(distance(without.landmark, LANDMARK) < 1e-9, 'the landmark is the origin of the turn, so it never needed it')
  }
  assert.ok(worstWithout > 1, `without the turn taken off the marker is metres from the tap (worst ${worstWithout} m): the bug this guards`)
  // At bearing 180 the turn is the identity, so the two readings agree.
  const identity = placeFrameToScene({ bearingDeg: 180 })
  const same = sessionAnchorPositions(multiply(identity, m), separation)
  assert.ok(distance(same.headingMarker!, MARKER) < 1e-9)
  // No turn (a world with no georeference, or a scan the georeference does not carry): the placement is the matrix, as it is.
  assert.deepEqual(sessionToProjectOfPlacement(m, null), m)
  assert.notEqual(sessionToProjectOfPlacement(m, null), m, 'a copy, not the caller\'s array')
  // The turn taken off is the calibration itself, element by element.
  const turn = placeFrameToScene({ bearingDeg: 77 })
  const back = sessionToProjectOfPlacement(multiply(turn, m), turn)
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(back[i]! - m[i]!) < 1e-12, `element ${i}`)
  // A turn that cannot be taken off (not a matrix) leaves the placement as it is; a placement that is not 16 numbers likewise.
  assert.deepEqual(sessionToProjectOfPlacement(m, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), m)
  assert.deepEqual(sessionToProjectOfPlacement([1, 2, 3], turn), [1, 2, 3])
})

test('the turn is Ry(180 - bearing): a Place-frame point on +Z goes where the scene puts a point that far along the bearing', () => {
  for (const bearing of [0, 45, 90, 200, 315]) {
    const turned = transformPoint(placeFrameToScene({ bearingDeg: bearing }), { x: 0, y: 0, z: 2.5 })
    const b = (bearing * Math.PI) / 180
    const want = sceneFromEnu({ east: 2.5 * Math.sin(b), north: 2.5 * Math.cos(b), up: 0 })
    assert.ok(distance(turned, want) < 1e-12, `bearing ${bearing}: ${JSON.stringify(turned)} against ${JSON.stringify(want)}`)
    assert.equal(transformPoint(placeFrameToScene({ bearingDeg: bearing }), { x: 0, y: 0, z: 0 }).x, 0, 'no move: the scene origin is the landmark')
  }
  assert.ok(placeFrameToScene({ bearingDeg: 30 }).every((n) => !Object.is(n, -0)), 'minus zero is written as zero')
})

test('the turn is asked for only where the placement holds it: a georeference, and a scan in the Place\'s frame', () => {
  const georeference = { bearingDeg: 75 }
  const twoPoint = { calibrationMethod: 'two-point-ground' }
  const frame = { method: 'two-point-ground', frameId: 'frame-a' }
  assert.deepEqual(placeFrameToSceneFor(georeference, twoPoint, frame), placeFrameToScene(georeference))
  // No georeference: the scene is the Place frame, and the scan sits as it was calibrated.
  assert.equal(placeFrameToSceneFor(null, twoPoint, frame), null)
  assert.equal(placeFrameToSceneFor(undefined, twoPoint, frame), null)
  // A scan of another tier is not carried by the georeference: its placement has no turn.
  assert.equal(placeFrameToSceneFor(georeference, { calibrationMethod: 'ground-tap-compass' }, frame), null)
  assert.equal(placeFrameToSceneFor(georeference, { calibrationMethod: 'known-distance' }, frame), null)
  assert.equal(placeFrameToSceneFor(georeference, {}, frame), null)
  // A scan calibrated against an earlier generation of the frame is not in this one; an unknown generation says nothing.
  assert.equal(placeFrameToSceneFor(georeference, { ...twoPoint, calibrationFrameId: 'frame-old' }, frame), null)
  assert.deepEqual(placeFrameToSceneFor(georeference, { ...twoPoint, calibrationFrameId: 'frame-a' }, frame), placeFrameToScene(georeference))
  assert.deepEqual(placeFrameToSceneFor(georeference, { ...twoPoint, calibrationFrameId: 'frame-old' }, { method: 'two-point-ground' }), placeFrameToScene(georeference), 'the Place\'s frame has no id: neutral')
  // A Place with no frame has nothing to differ from.
  assert.deepEqual(placeFrameToSceneFor(georeference, twoPoint, null), placeFrameToScene(georeference))
})
