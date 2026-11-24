/**
 * Who placed a scan, and where the editor draws it: the rules the server and the editor share about a scan's patch log, so that they
 * cannot disagree about where a scan is. They build on `liveScanPlacementPatches` (./scan-placement.ts), the one reader that knows an
 * undone move and the record of its undo are not moves that still count.
 *
 * Node-API-free on purpose (ADR 0002): the editor imports this file, and so do Node tests and the server's placement
 * (server/world/world_origin.ts, docs/adr/0015-scene-convention-and-georeference.md).
 *
 *  - {@link replayedScanPlacement} is where the editor puts a scan.
 *  - {@link isHandPlaced} says a person placed it, and so a georeference does not move it.
 *  - {@link scansOutsidePlaceFrame} is the mixed-Place rule (D6): the scans an editor banner counts. Thing matching leaves them out,
 *    with every other scan that is not in the Place frame (`scanTakesPartInThingMatching`, server/thing_match.ts).
 */
import { liveScanPlacementPatches } from './scan-placement.ts'
import type { EditPatch, ScanManifest } from './types.ts'

/** Whether two matrices are the same 16 numbers (`-0` and `0` are the same number). False when either is not 16 numbers. */
export function sameMatrix(a: readonly number[] | null | undefined, b: readonly number[] | null | undefined): boolean {
  if (!a || !b || a.length !== 16 || b.length !== 16) return false
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Where the editor puts a scan: the matrix the world holds for it, with the moves that still count replayed over it, the last one
 * winning (a placement patch is absolute). An undone move, and the record its undo left, are not replayed
 * ({@link liveScanPlacementPatches}): the record carries the placement the scan had when it was undone, which stops being the
 * scan's placement the day the server places it again (a new georeference), and a reader that replayed it would draw the scan where
 * an older placement had it while the world, the scan list and the exports say it is somewhere else.
 */
export function replayedScanPlacement(patches: readonly EditPatch[], scan: Pick<ScanManifest, 'scanId' | 'filename' | 'localToWorld'>): number[] {
  const matrix = liveScanPlacementPatches(patches, scan).at(-1)?.transform?.matrix
  return Array.isArray(matrix) ? matrix : scan.localToWorld
}

/**
 * Whether a person placed `scan`: a placement patch that still counts holds it, and it is not where its calibration puts it. A scan
 * whose last move was "reset to calibrated" is at its calibration, and so is one an undo took back to it: its patch log is not empty,
 * and nobody placed it. A scan with no stored first placement cannot be shown to be at it, so with a move that counts, a person
 * placed it.
 */
export function isHandPlaced(
  patches: readonly EditPatch[],
  scan: Pick<ScanManifest, 'scanId' | 'filename' | 'localToWorld' | 'calibratedLocalToWorld'>,
): boolean {
  if (liveScanPlacementPatches(patches, scan).length === 0) return false
  return !sameMatrix(scan.localToWorld, scan.calibratedLocalToWorld)
}

/**
 * The scans of a mixed Place that are not in its frame (D6): when the Place has scans in its frame (`'place-frame'` or
 * `'georeference'`) and others that are not (`'gps-compass'` or `'grid'`), the others. The two kinds are in unrelated frames, so the
 * editor says so and Thing matching leaves the others out until they are calibrated. A scan that a person placed (`isHandPlaced`) is
 * where they put it and is not one of them. A Place with no scan in its frame has no frame to be outside of, and a scan with no
 * stamp (a row from before placements were recorded) says nothing: neither is counted.
 */
export function scansOutsidePlaceFrame<S extends Pick<ScanManifest, 'scanId' | 'filename' | 'localToWorld' | 'calibratedLocalToWorld' | 'placementSource'>>(
  world: { scans: readonly S[]; editPatches: readonly EditPatch[] },
): S[] {
  const inFrame = (scan: S) => scan.placementSource === 'place-frame' || scan.placementSource === 'georeference'
  if (!world.scans.some(inFrame)) return []
  return world.scans.filter((scan) =>
    (scan.placementSource === 'gps-compass' || scan.placementSource === 'grid') && !isHandPlaced(world.editPatches ?? [], scan)
  )
}
