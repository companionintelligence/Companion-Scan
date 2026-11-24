/**
 * Who placed a scan, and where the editor draws it (src/world/scan-hand-placement.ts): the rules the server and the editor share about the
 * patch log of a scan, so that they cannot disagree about where it is.
 *
 * What is pinned:
 *
 *  - `replayedScanPlacement` is where the editor puts a scan: its matrix with the moves that still count replayed over it. A move that
 *    was undone, and the record the undo left, are not replayed. The record carries the placement the scan had when it was undone;
 *    once the server places the scan again (a new georeference) that is an older placement, and a reader that replayed it drew the
 *    scan where an older georeference had it while the world, the scan list and the exports said it was somewhere else;
 *  - `isHandPlaced` says a person placed a scan only when a move that still counts holds it somewhere other than where its calibration
 *    puts it: a scan reset to its calibration, or taken back to it by an undo, has a patch log and nobody placed it;
 *  - `scansOutsidePlaceFrame` is the mixed-Place rule (D6): scans placed by GPS or on the grid are outside a Place that has scans in its
 *    frame, unless a person placed them, and there is nothing to be outside of in a Place with none.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/scan_placement_by_hand.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isHandPlaced, replayedScanPlacement, sameMatrix, scansOutsidePlaceFrame } from '../../../src/world/scan-hand-placement.ts'
import type { EditPatch, ScanManifest } from '../../../src/world/types.ts'

const at = (x: number): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]

const scan = (extra: Partial<ScanManifest> = {}): ScanManifest => ({
  scanId: 'scan-a',
  projectId: 'proj-1',
  sessionId: null,
  filename: 'a.glb',
  name: 'a',
  glbUrl: '/scans/a.glb',
  geoPose: { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null },
  localToWorld: at(1),
  accuracyM: null,
  geoDistanceM: null,
  capturedAt: null,
  pointCount: null,
  detectionCount: null,
  layerIndex: [],
  status: 'ready',
  ...extra,
})

const patch = (patchId: string, matrix: number[], extra: Partial<EditPatch> = {}): EditPatch => ({
  patchId,
  worldId: 'world-1',
  scanId: 'scan-a',
  targetId: 'a.glb',
  scope: 'scan',
  transform: { matrix, position: { x: matrix[12]!, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
  createdAt: '2026-11-17T10:00:00.000Z',
  ...extra,
})

test('sameMatrix: the same sixteen numbers, minus zero being zero, and nothing that is not sixteen numbers', () => {
  assert.equal(sameMatrix(at(1), at(1)), true)
  assert.equal(sameMatrix([...at(1)], at(1)), true)
  assert.equal(sameMatrix(at(1).map((n) => (n === 0 ? -0 : n)), at(1)), true)
  assert.equal(sameMatrix(at(1), at(1.000001)), false)
  assert.equal(sameMatrix(at(1), at(1).slice(0, 15)), false)
  assert.equal(sameMatrix(at(1), [...at(1), 0]), false, 'seventeen numbers are not a matrix, whatever the first sixteen say')
  assert.equal(sameMatrix([1, 2, 3], [1, 2, 3]), false, 'and neither is a list that is the same short list')
  assert.equal(sameMatrix([], []), false)
  assert.equal(sameMatrix(at(1), undefined), false)
  assert.equal(sameMatrix(null, null), false)
})

test('replayedScanPlacement: the stored matrix, then the moves that still count, the last one winning', () => {
  assert.deepEqual(replayedScanPlacement([], scan()), at(1), 'no move: the world\'s own matrix')
  assert.deepEqual(replayedScanPlacement([patch('p1', at(5))], scan()), at(5))
  assert.deepEqual(replayedScanPlacement([patch('p1', at(5)), patch('p2', at(6))], scan()), at(6), 'a placement patch is absolute: the last wins')
  // A patch for another scan is not this scan's, whichever way it names it.
  assert.deepEqual(replayedScanPlacement([patch('p1', at(5), { scanId: 'scan-b', targetId: 'b.glb' })], scan()), at(1))
  // By the filename alone, as the server's own match does.
  assert.deepEqual(replayedScanPlacement([patch('p1', at(5), { scanId: undefined })], scan()), at(5))
})

test('replayedScanPlacement: an undone move and the record of its undo are not replayed, so a scan the server placed again is not drawn where the undo left it', () => {
  // The regression. A person moved the scan (p1) and took it back (u1, which carries the placement it went back to). The server has
  // since placed the scan again, and the world's matrix is the new one. The old replay applied every scan patch in order, so the undo
  // record's matrix (the OLD placement) won over the world's.
  const placedAgain = scan({ localToWorld: at(9) })
  const log = [patch('p1', at(5)), patch('u1', at(1), { revertsPatchId: 'p1' })]
  assert.deepEqual(replayedScanPlacement(log, placedAgain), at(9))
  // An earlier move that still counts survives the undo of a later one; its matrix is the one the undo restored.
  const two = [patch('p1', at(5)), patch('p2', at(6)), patch('u2', at(5), { revertsPatchId: 'p2' })]
  assert.deepEqual(replayedScanPlacement(two, placedAgain), at(5))
  // A second undo steps back past the first and takes the earlier move away too.
  const both = [...two, patch('u1', at(1), { revertsPatchId: 'p1' })]
  assert.deepEqual(replayedScanPlacement(both, placedAgain), at(9))
  // An entry that is not a patch at all is skipped.
  assert.deepEqual(replayedScanPlacement([null as never, patch('p1', at(5))], scan()), at(5))
})

test('isHandPlaced: a move that still counts holds the scan somewhere other than its calibration; a reset, an undo and no move at all are nobody\'s placement', () => {
  const calibrated = at(1)
  const row = (localToWorld: number[]) => scan({ localToWorld, calibratedLocalToWorld: calibrated })
  assert.equal(isHandPlaced([], row(at(1))), false, 'no move')
  assert.equal(isHandPlaced([patch('p1', at(5))], row(at(5))), true, 'moved, and it is not at its calibration')
  assert.equal(isHandPlaced([patch('p1', at(5)), patch('r1', at(1))], row(at(1))), false, 'reset to calibrated: the log is not empty and the scan is at its calibration')
  assert.equal(isHandPlaced([patch('p1', at(5)), patch('u1', at(1), { revertsPatchId: 'p1' })], row(at(1))), false, 'a move that was undone')
  assert.equal(isHandPlaced([patch('p1', at(5)), patch('u1', at(1), { revertsPatchId: 'p1' })], row(at(2))), false, 'an undone move, whatever the matrix says now: no move counts')
  // A scan with no stored first placement cannot be shown to be at it: with a move that counts, a person placed it.
  assert.equal(isHandPlaced([patch('p1', at(1))], scan({ localToWorld: at(1) })), true)
})

const placed = (name: string, source: ScanManifest['placementSource'], extra: Partial<ScanManifest> = {}): ScanManifest =>
  scan({ scanId: `scan-${name}`, filename: `${name}.glb`, name, ...(source ? { placementSource: source } : {}), calibratedLocalToWorld: at(1), localToWorld: at(1), ...extra })

test('scansOutsidePlaceFrame: in a Place with scans in its frame, those placed by GPS or on the grid are outside it; a person\'s placement is not, and a Place with none has no frame to be outside of', () => {
  const mixed = {
    scans: [placed('cal', 'georeference'), placed('gps', 'gps-compass'), placed('grid', 'grid'), placed('unstamped', undefined), placed('moved', 'gps-compass', { localToWorld: at(7) })],
    editPatches: [patch('p-moved', at(7), { scanId: 'scan-moved', targetId: 'moved.glb' })],
  }
  assert.deepEqual(scansOutsidePlaceFrame(mixed).map((s) => s.name), ['gps', 'grid'], 'a person placed "moved", and a row with no stamp says nothing')
  // A frame without a georeference counts the same.
  assert.deepEqual(scansOutsidePlaceFrame({ scans: [placed('cal', 'place-frame'), placed('gps', 'gps-compass')], editPatches: [] }).map((s) => s.name), ['gps'])
  // No scan in the frame: nothing is outside it.
  assert.deepEqual(scansOutsidePlaceFrame({ scans: [placed('gps', 'gps-compass'), placed('grid', 'grid')], editPatches: [] }), [])
  assert.deepEqual(scansOutsidePlaceFrame({ scans: [], editPatches: [] }), [])
})
