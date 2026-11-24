/**
 * Where a scan goes in a Place's world: the world's origin, the placement of a calibrated scan through the Place's
 * georeference, the placement of a scan with no calibration, and what changes when the georeference does.
 *
 * Node-API-free on purpose, like ./world_membership.ts (ADR 0004: server/main.ts cannot be imported by a test, so what
 * can be tested on its own lives here). It takes the world, the Place's facts and a few readers of a sidecar, and
 * returns matrices and stamps; the hooks in `scanManifestFromStored`, `synthesizeWorld` and `refreshWorldScans`
 * (server/main.ts) are a few lines each that call it. The decision is docs/adr/0015-scene-convention-and-georeference.md.
 *
 * ## Two conventions in one server
 *
 * A world declares its axes (`localFrame.axes.z`). `'north'` is every world file written before this decision: its
 * (east, up, north) axes are left-handed, and what was placed in it from GPS and compass is mirrored (ADR 0015, 1).
 * Nothing here recomputes such a world, and a scan added to it is placed exactly as it always was
 * (server/main.ts keeps that path; `tests/unit/server/world_placement_golden.test.ts` holds it bit for bit). `'south'` is the
 * right-handed scene: x east, y up, z south. A new world declares it, and a legacy world declares it the day its Place gets
 * a georeference and its scans are placed again. This file places scans in the second.
 *
 * ## Matrices
 *
 * Column-major 4x4 numbers in a plain array, the layout of `ScanManifest.localToWorld`, `composeYUpTransform` and
 * three.js `Matrix4.elements`, applied to a point as `M * p`. `A x B` below is `multiplyColumnMajor(A, B)`: B acts first.
 * `composeYUpTransform(t, yaw)` is `T(t) x Ry(yaw)`: the turn first, then the move.
 *
 *     calibrated:    M = T(sceneFromEnu(geodeticToEnu(worldOrigin, origin))) x Ry(180 - bearing) x projectTransform
 *     uncalibrated:  M = T(sceneFromEnu(E, 0, N)) x Ry(180 - B_Z)
 *
 * `projectTransform` is the scan's `sessionToProject`: a session point to the Place frame. `Ry(180 - bearing)` turns the
 * Place frame, whose +Z has true bearing `bearing`, onto the scene (`sceneYawForBearingDeg` in src/world/enu.ts: a rotation
 * by it carries +Z onto the scene direction of that bearing, east `sin b`, z `-cos b`). Heights are the Place floor: y is 0 in
 * the Place frame and the translation never has a height in it.
 */
import { geodeticToEnu, sceneFromEnu, sceneYawForBearingDeg } from '../../src/world/enu.ts'
import { invertAffine } from '../../src/world/anchor-placement.ts'
import { composeYUpTransform, hasGeoPose, transformPoint } from '../../src/world/geo.ts'
import { GEO_SESSION_KEY, type GeoSession, parseGeoSession } from '../../src/world/geo-session.ts'
import {
  accuracyAt,
  type FrameMethod,
  frameOffsetToEnu,
  georeferenceFrameState,
  georeferenceOriginAsGeoPose,
  inPlaceFrame,
  LEVER_ARM_MIN_M,
  PLACEMENT_MAX_BEARING_SPREAD_DEG,
  PLACEMENT_MAX_FIX_ACCURACY_M,
  PLACEMENT_MAX_FIX_AGE_S,
  placeGeorefVersion,
  readStoredGeoreference,
  sameGeoreference,
  seedOriginAccuracyM,
} from '../../src/world/georef.ts'
import { liveScanPlacementPatches, normaliseZeros, placementTransform } from '../../src/world/scan-placement.ts'
import { isHandPlaced, sameMatrix } from '../../src/world/scan-hand-placement.ts'
import type {
  EditPatch,
  GeoPose,
  Project,
  ProjectGeoreference,
  ScanManifest,
  ScanPlacementSource,
  Vec3,
  WorldProject,
} from '../../src/world/types.ts'
import { asCalibrationMethod, calibrationFromMeta } from '../calibration_fields.ts'

// What the older importers of this file read from it: the matrix comparison, the frame test and the frame method now live in the browser-safe modules.
export { inPlaceFrame, sameMatrix }
export type { FrameMethod }

const DEG_TO_RAD = Math.PI / 180

// ─── Matrices ────────────────────────────────────────────────────────────────

/** Column-major 4x4 product `a x b`: `b` acts first. Both are 16 numbers. */
export function multiplyColumnMajor(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0)
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[column * 4 + k]!
      out[column * 4 + row] = sum
    }
  }
  return out
}

// ─── The world's origin ──────────────────────────────────────────────────────

const NO_ORIGIN: GeoPose = { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }

/**
 * The origin of a world: the Place's georeference origin when it has one, else the located scan with the best accuracy (not
 * the newest: a newest scan with a 60 m fix made a world's origin 60 m from its building), else none (null). A scan is
 * located when it has a latitude and a longitude that are not the (0, 0) of a missing fix (`hasGeoPose`). A scan with no
 * accuracy figure ranks after every scan with one, and equally accurate scans keep the order they were given in, so a
 * caller that lists newest first gets the newest of the equally good. The origin is a `GeoPose`, as `world.originGeoPose` is.
 */
export function resolveWorldOrigin(
  georeference: ProjectGeoreference | null | undefined,
  scans: ReadonlyArray<{ geoPose: GeoPose }>,
): GeoPose | null {
  if (georeference) return georeferenceOriginAsGeoPose(georeference)
  let best: GeoPose | null = null
  for (const { geoPose } of scans) {
    if (!hasGeoPose(geoPose)) continue
    const accuracy = typeof geoPose.accuracyM === 'number' && Number.isFinite(geoPose.accuracyM) && geoPose.accuracyM >= 0 ? geoPose.accuracyM : Infinity
    const bestAccuracy = best === null
      ? Infinity
      : typeof best.accuracyM === 'number' && Number.isFinite(best.accuracyM) && best.accuracyM >= 0 ? best.accuracyM : Infinity
    if (best === null || accuracy < bestAccuracy) best = geoPose
  }
  return best
}

/** `resolveWorldOrigin` as `world.originGeoPose` holds it: a world with no origin has a `GeoPose` of nulls, never a missing value. */
export function worldOriginOrNone(origin: GeoPose | null): GeoPose {
  return origin ?? { ...NO_ORIGIN }
}

// ─── The Place and the world, as placement sees them ─────────────────────────

export type WorldConvention = 'legacy' | 'scene'

/** `'scene'` when the world declares the right-handed scene (`z: 'south'`), `'legacy'` for every world file written before it. */
export function worldConvention(world: Pick<WorldProject, 'localFrame'>): WorldConvention {
  return world.localFrame?.axes?.z === 'south' ? 'scene' : 'legacy'
}

/** What placement needs to know about a world's Place. */
export interface PlaceFacts {
  /** The Place's georeference when it holds one that is well formed and made for the frame it holds now, else null. */
  georeference: ProjectGeoreference | null
  /** How many georeference writes the Place has accepted: 0 when none. */
  georefVersion: number
  /** The method of the Place's stored frame: which scans are in it. Null when the Place has no frame. */
  frameMethod: FrameMethod | null
  /** The identity of the Place's stored frame (`frameId`), when it has one: which generation of the frame scans were calibrated against. */
  frameId?: string | null
}

/**
 * The facts of a Place that placement reads, from the registry's record (or none: a world with no Place, the legacy default
 * world, or a Place that was deleted). A georeference is ignored, and `onInvalid` hears why, when
 *
 *  - it is not well formed (`readStoredGeoreference`): the registry is a file a person can edit, and a record no check has seen is not one to
 *    place a world by. A record that is well formed and claims less error than the floors of today allow is not ignored: it is read
 *    holding to them, so a floor a measurement raises later does not make a Place forget its registration; or
 *  - it was made for another frame than the one the Place holds now (both frame ids are known and differ): the Place's alignment
 *    was made again after the location was saved, and the location is of the earlier one. The editor's panel says so and offers
 *    the save again. A frame or a record with no id says nothing, and the record stands.
 */
export function placeFactsFor(place: Project | null | undefined, onInvalid?: (reason: string) => void): PlaceFacts {
  const frame = place?.spatialFrame as { method?: unknown; frameId?: unknown } | undefined
  let georeference: ProjectGeoreference | null = null
  if (place?.georeference !== undefined && place.georeference !== null) {
    const check = readStoredGeoreference(place.georeference)
    if (!check.ok) onInvalid?.(check.error)
    else if (georeferenceFrameState(check.georeference, frame) === 'other-frame') onInvalid?.('it was made for another alignment of the Place than the one it holds now')
    else georeference = check.georeference
  }
  const method = frame?.method
  return {
    georeference,
    georefVersion: georeference ? placeGeorefVersion(place) : 0,
    frameMethod: method === 'two-point-ground' || method === 'ground-tap-compass' ? method : null,
    ...(typeof frame?.frameId === 'string' ? { frameId: frame.frameId } : {}),
  }
}

/**
 * What the world itself remembers of its Place, for a read that could not get the Place (the registry file was unreadable that
 * moment): the record it was placed under and its version, and no frame (the world does not remember its method, so a scan of any
 * tier would read as being in it). Nothing is changed from these: `applyPlaceGeoreference` is not called, so a registry that is
 * briefly unreadable can never make a world forget its georeference, and no scan is added from them either (server/main.ts waits for
 * the Place), because placing a calibrated scan needs the frame's method.
 */
export function placeFactsFromWorld(world: Pick<WorldProject, 'georeference' | 'georefVersion'>): PlaceFacts {
  return { georeference: world.georeference ?? null, georefVersion: placeGeorefVersion(world), frameMethod: null }
}

export interface WorldPlacementContext {
  convention: WorldConvention
  georeference: ProjectGeoreference | null
  georefVersion: number
  frameMethod: PlaceFacts['frameMethod']
  /** The identity of the Place's frame, when it has one (`PlaceFacts.frameId`). */
  frameId?: string | null
  /** The world's origin: where the scene's (0, 0, 0) is. The georeference's origin when there is one. */
  worldOrigin: GeoPose
  /** The farthest a scan's fix may be from the origin and still place it, metres (`WORLD_SCAN_MAX_RADIUS_M`). */
  maxRadiusM: number
}

export function placementContext(world: WorldProject, place: PlaceFacts, maxRadiusM: number): WorldPlacementContext {
  return {
    convention: worldConvention(world),
    georeference: place.georeference,
    georefVersion: place.georefVersion,
    frameMethod: place.frameMethod,
    ...(place.frameId ? { frameId: place.frameId } : {}),
    worldOrigin: world.originGeoPose ?? NO_ORIGIN,
    maxRadiusM,
  }
}

// ─── What a scan's sidecar says about where it is ────────────────────────────

export interface ScanPlacementFacts {
  geoPose: GeoPose
  /** The sidecar's `projectTransform` when it is 16 finite numbers: the scan's `sessionToProject`. */
  projectTransform: number[] | null
  /** The tier of the scan's calibration, when it names one. */
  calibrationMethod: ScanManifest['calibrationMethod']
  /** The generation of the Place's frame the scan was calibrated against, when its sidecar names one (`ScanManifest.calibrationFrameId`). */
  calibrationFrameId?: string
  /** What the session recorded of the walk, when the sidecar has it (a scan from before this decision has not). */
  geoSession: GeoSession | null
}

/** The facts of a stored scan, from its sidecar and the readers `server/main.ts` already has (`geoPoseFromMeta`, `matrixFromMeta`). */
export function scanPlacementFacts(meta: Record<string, unknown>, geoPose: GeoPose, projectTransform: number[] | null): ScanPlacementFacts {
  const calibrationFrameId = calibrationFromMeta(meta).calibrationFrameId
  return {
    geoPose,
    projectTransform,
    calibrationMethod: asCalibrationMethod(meta['calibrationMethod']),
    ...(calibrationFrameId === undefined ? {} : { calibrationFrameId }),
    geoSession: parseGeoSession(meta[GEO_SESSION_KEY]),
  }
}

/** Whether a scan's calibration is in the Place's frame: `inPlaceFrame` (src/world/georef.ts), with the generations the facts hold. */
function inFrameOf(facts: Pick<ScanPlacementFacts, 'calibrationMethod' | 'calibrationFrameId'>, place: Pick<PlaceFacts, 'frameMethod' | 'frameId'>): boolean {
  return inPlaceFrame(facts.calibrationMethod, place.frameMethod, { scan: facts.calibrationFrameId, place: place.frameId })
}

// ─── Placing a calibrated scan ───────────────────────────────────────────────

/** The east and north offset of one position from another, metres, on the ellipsoid at the same height (the Place floor). */
function groundOffset(from: { lat: number; lng: number }, to: { lat: number; lng: number }): { east: number; north: number } {
  const enu = geodeticToEnu({ lat: from.lat, lng: from.lng, altitudeM: 0 }, { lat: to.lat, lng: to.lng, altitudeM: 0 })
  return { east: enu.east, north: enu.north }
}

/**
 * A calibrated scan's placement through the Place's georeference:
 * `T(sceneFromEnu(geodeticToEnu(worldOrigin, georeference.origin))) x Ry(180 - bearing) x projectTransform`.
 *
 * `worldOrigin` is the world's origin (`resolveWorldOrigin`), which is the georeference's own origin once a world has one,
 * and then the translation is exactly zero and the scene's (0, 0, 0) is the Place's landmark. It is still a parameter so
 * that the offset between two origins is one formula and a test can check it. Both positions are taken at the same height
 * (0): a Place's height is its floor and a vertical offset is never read from a GPS altitude. `-0` is written as 0.
 */
export function placeCalibratedScan(
  georeference: ProjectGeoreference,
  worldOrigin: { lat: number; lng: number },
  projectTransform: readonly number[],
): number[] {
  const offset = groundOffset(worldOrigin, georeference.origin)
  const placement = composeYUpTransform(
    sceneFromEnu({ east: offset.east, north: offset.north, up: 0 }),
    sceneYawForBearingDeg(georeference.bearingDeg),
    1,
  )
  return normaliseZeros(multiplyColumnMajor(placement, projectTransform))
}

// ─── Placing a scan ──────────────────────────────────────────────────────────

/** Why a scan with a fix and a compass is not placed by them. Not shown to a person: the scan list says "on the grid". */
export type GridReason =
  | 'no-fix'
  | 'no-origin'
  | 'no-accuracy'
  | 'fix-accuracy'
  | 'fix-age'
  | 'no-bearing'
  | 'bearing-spread'
  | 'outlier'

export interface ScanPlacement {
  matrix: number[]
  /** What set the matrix, or null for a scan this decision says nothing about (a calibration of another frame). */
  source: ScanPlacementSource | null
  /** How far the scan may be from where the matrix puts it, metres (R68), when that can be said. */
  uncertaintyM: number | null
  /** The horizontal distance between the world's origin and the scan's fix, metres, or null when either is missing. */
  geoDistanceM: number | null
  geoOutlier: boolean
  /** Set when the scan is on the grid: why. */
  gridReason: GridReason | null
}

/** The slot of the default grid: 3 m apart, six to a row. A scan with nothing to place it by stands here, unturned. */
export function gridMatrix(index: number): number[] {
  return normaliseZeros(composeYUpTransform({ x: (index % 6) * 3, y: 0, z: Math.floor(index / 6) * 3 }, 0, 1))
}

/**
 * The origin a scan is placed against. A Place with a georeference has one origin, the georeference's: it is the scene's
 * (0, 0, 0) by definition, so it is read from the record and not from a world file that a stale copy could contradict.
 */
function effectiveOrigin(ctx: WorldPlacementContext): GeoPose {
  return ctx.georeference ? georeferenceOriginAsGeoPose(ctx.georeference) : ctx.worldOrigin
}

/**
 * What stops a scan from being placed by its fix and its compass, or null when nothing does. The gates are the ones of
 * ADR 0015: a fix worse than 25 m or with no accuracy, taken more than 60 s before the walk began or more than 60 s after it, a
 * session bearing whose spread is over 30 degrees or that is missing (a sidecar from before sessions were sampled has a device
 * heading, which is not the session's), and a fix farther from the world's origin than the radius.
 */
function gridReasonFor(facts: ScanPlacementFacts, origin: GeoPose, maxRadiusM: number, distanceM: number | null): GridReason | null {
  const geo = facts.geoPose
  if (!hasGeoPose(geo)) return 'no-fix'
  if (!hasGeoPose(origin)) return 'no-origin'
  if (typeof geo.accuracyM !== 'number' || !Number.isFinite(geo.accuracyM) || geo.accuracyM <= 0) return 'no-accuracy'
  if (geo.accuracyM > PLACEMENT_MAX_FIX_ACCURACY_M) return 'fix-accuracy'

  const session = facts.geoSession
  // How far from the walk's beginning the fix was taken, either way. A fix from before the walk is as old as the seconds between
  // (the phone's last, restored from an earlier page load, can be hours old). A fix from after it is where the phone then was, which
  // is not where the session began: the capture records the best fix of the walk's first minute with the camera's position at it,
  // so a fix later than that is a position nothing can carry back to the session's origin (no lever arm is recorded for it), and
  // the error is as large as the distance walked. No time on either side is no age to judge by.
  const fixedAt = typeof geo.fixedAt === 'string' ? Date.parse(geo.fixedAt) : Number.NaN
  const startedAt = session ? Date.parse(session.startedAt) : Number.NaN
  if (!Number.isFinite(fixedAt) || !Number.isFinite(startedAt)) return session ? 'fix-age' : 'no-bearing'
  if (Math.abs(fixedAt - startedAt) / 1000 > PLACEMENT_MAX_FIX_AGE_S) return 'fix-age'

  if (!session?.bearing) return 'no-bearing'
  if (session.bearing.spreadDeg > PLACEMENT_MAX_BEARING_SPREAD_DEG) return 'bearing-spread'
  if (distanceM !== null && distanceM > maxRadiusM) return 'outlier'
  return null
}

/**
 * A scan's placement in the right-handed scene. One function decides, for every scan, in this order:
 *
 *  1. A scan with a calibration in the Place's frame sits at its `projectTransform`, carried through the georeference when the
 *     Place has one (`placeCalibratedScan`, source `'georeference'`, its uncertainty the origin's and the bearing's at the
 *     distance of the scan's origin from the Place's), and as it is when it has none (`'place-frame'`: a position in the Place
 *     and none on Earth, so no uncertainty to state). The grid and the fix play no part.
 *  2. A scan with a calibration of another frame sits at its `projectTransform` as it is, and this decision says nothing about it.
 *  3. A scan with no calibration is placed by its fix and the session's compass through `T(sceneFromEnu(E, 0, N)) x Ry(180 - B_Z)`
 *     (`'gps-compass'`, approximate) when it passes the gates, and stands on the grid (`'grid'`, no yaw) when it does not.
 *
 * `fallbackIndex` is the scan's slot on the grid. The matrix never holds a GPS altitude, and a null height is never a 0 that is
 * read as a measurement: the height is the Place floor.
 */
export function placeSceneScan(facts: ScanPlacementFacts, ctx: WorldPlacementContext, fallbackIndex: number): ScanPlacement {
  const geo = facts.geoPose
  const origin = effectiveOrigin(ctx)
  const located = hasGeoPose(geo) && hasGeoPose(origin)
  const offset = located ? groundOffset(origin as { lat: number; lng: number }, geo as { lat: number; lng: number }) : null
  const distanceM = offset ? Math.hypot(offset.east, offset.north) : null

  if (facts.projectTransform) {
    const inFrame = inFrameOf(facts, ctx)
    if (inFrame && ctx.georeference) {
      const distance = Math.hypot(facts.projectTransform[12]!, facts.projectTransform[14]!)
      return {
        matrix: placeCalibratedScan(ctx.georeference, origin as { lat: number; lng: number }, facts.projectTransform),
        source: 'georeference',
        uncertaintyM: accuracyAt(ctx.georeference, distance),
        geoDistanceM: distanceM,
        geoOutlier: false,
        gridReason: null,
      }
    }
    return {
      matrix: normaliseZeros(facts.projectTransform),
      source: inFrame ? 'place-frame' : null,
      uncertaintyM: null,
      geoDistanceM: distanceM,
      geoOutlier: false,
      gridReason: null,
    }
  }

  const reason = gridReasonFor(facts, origin, ctx.maxRadiusM, distanceM)
  if (reason !== null || !offset) {
    return {
      matrix: gridMatrix(fallbackIndex),
      source: 'grid',
      uncertaintyM: null,
      geoDistanceM: distanceM,
      geoOutlier: reason === 'outlier',
      gridReason: reason ?? 'no-origin',
    }
  }

  const bearing = facts.geoSession!.bearing!
  let { east, north } = offset
  let uncertainty = seedOriginAccuracyM(geo.accuracyM!)
  // The fix is where the phone was, not where the session began. Past a few metres the walk is added back: the camera's
  // session position at the fix, turned into east and north by the session's own bearing, is taken off.
  const fix = facts.geoSession!.fix
  if (fix && fix.sessionX !== null && fix.sessionZ !== null) {
    const lever = Math.hypot(fix.sessionX, fix.sessionZ)
    if (lever > LEVER_ARM_MIN_M) {
      const turned = frameOffsetToEnu(bearing.deg, fix.sessionX, fix.sessionZ)
      east -= turned.east
      north -= turned.north
      uncertainty = Math.hypot(uncertainty, lever * bearing.sigmaDeg * DEG_TO_RAD)
    }
  }
  return {
    matrix: normaliseZeros(composeYUpTransform(sceneFromEnu({ east, north, up: 0 }), sceneYawForBearingDeg(bearing.deg), 1)),
    source: 'gps-compass',
    uncertaintyM: uncertainty,
    geoDistanceM: distanceM,
    geoOutlier: false,
    gridReason: null,
  }
}

/** The manifest fields a placement writes: left off, not nulled, for a placement this decision says nothing about. */
export function placementFields(placement: ScanPlacement): Pick<ScanManifest, 'placementSource' | 'placementUncertaintyM'> {
  return placement.source === null ? {} : { placementSource: placement.source, placementUncertaintyM: placement.uncertaintyM }
}

/**
 * What a scan's calibration puts it at under the Place as it is now: the matrix "reset to calibrated" returns to, which a
 * georeference carries with it. Undefined for a scan with no calibration in the Place's frame, whose first placement is the
 * matrix it was first given (`stampFirstSightPlacements` in src/world/scan-placement.ts takes it from the sidecar, or from the row).
 */
export function calibratedPlacement(facts: ScanPlacementFacts | null, ctx: WorldPlacementContext): number[] | undefined {
  if (!facts?.projectTransform) return undefined
  if (ctx.georeference && inFrameOf(facts, ctx)) {
    return placeCalibratedScan(ctx.georeference, effectiveOrigin(ctx) as { lat: number; lng: number }, facts.projectTransform)
  }
  return facts.projectTransform
}

// ─── A world and its georeference ────────────────────────────────────────────

/** What the refresh gives the module: a stored scan's sidecar, and the readers `server/main.ts` owns. */
export interface PlacementHost {
  maxRadiusM: number
  /** The sidecar of the scan with this filename, or undefined when it is not on disk (a session-backed scan has none). */
  metaFor: (filename: string) => Record<string, unknown> | undefined
  geoPoseFor: (meta: Record<string, unknown>) => GeoPose
  matrixFor: (value: unknown) => number[] | null
  /** An ISO time for the records the server writes into the patch log: the clock when absent. */
  now?: () => string
}

/** The placement facts of the stored scan with this filename, or null when it is not on disk (a session-backed scan has no sidecar). */
export function placementFactsFor(host: PlacementHost, filename: string): ScanPlacementFacts | null {
  const meta = host.metaFor(filename)
  return meta ? scanPlacementFacts(meta, host.geoPoseFor(meta), host.matrixFor(meta['projectTransform'])) : null
}

/** Who writes the records the server leaves in a scan's patch log when it places a scan that a person had reset again. */
export const GEOREFERENCE_ACTOR = 'georeference'

/**
 * A scan that a person had reset to its calibration is placed again with its calibration, and the moves in its log that still count are
 * the ones that hold it where the calibration used to put it: each is taken back by a record that carries the new placement, as an
 * undo does (`EditPatch.revertsPatchId`), so that the log replayed in order ends where the world says the scan is, and the scan is not
 * held by a move nobody made.
 */
function supersedeMoves(world: WorldProject, scan: ScanManifest, live: readonly EditPatch[], matrix: number[], version: number, createdAt: string): void {
  for (const patch of live) {
    world.editPatches.push({
      patchId: `${patch.patchId}-placed-again-v${version}`,
      worldId: world.worldId,
      scanId: scan.scanId,
      targetId: scan.filename,
      scope: 'scan',
      transform: placementTransform(matrix),
      actorId: GEOREFERENCE_ACTOR,
      revertsPatchId: patch.patchId,
      createdAt,
    })
  }
}

/** Where a scan's `from` placement put a point, `to` puts it: the point carried with the scan. Null when `from` has no inverse. */
function carried(point: Vec3, move: { from: number[]; to: number[] }): Vec3 | null {
  const back = invertAffine(move.from)
  return back ? transformPoint(move.to, transformPoint(back, point)) : null
}

/**
 * Things and their observations are positions in the world's frame, worked out at the moment a correspondence job ran, through the
 * scan's placement of that moment. A scan placed again takes them with it: an observation moves as its scan did, and a Thing moves as
 * the scan that first saw it did (its position is that scan's detection). Nothing else moves them: a Thing left behind sits metres
 * from the object the scan now shows, and an export would carry it next to a scan it no longer matches. A Thing a person placed by a
 * `scope: 'thing'` patch is that patch's position, which no scan carries.
 */
function carryThings(world: WorldProject, moves: ReadonlyMap<string, { from: number[]; to: number[] }>): void {
  for (const observation of world.thingObservations ?? []) {
    const move = moves.get(observation.scanId)
    const at = move ? carried(observation.worldPos, move) : null
    if (at) observation.worldPos = at
  }
  for (const thing of world.things ?? []) {
    const move = moves.get(thing.firstSeenScanId)
    const at = move ? carried(thing.position, move) : null
    if (at) thing.position = at
  }
}

/**
 * Brings a world's placements into line with its Place's georeference, when the Place's version is not the one the world's
 * were made under. Runs inside the world's lock (ADR 0004), on every read; does nothing unless the version differs.
 *
 *  - The world declares the right-handed scene, its origin is the georeference's, and it records the version and the record.
 *  - A scan that a person did not place (`isHandPlaced`) is placed again (`placeSceneScan`), and what it started as
 *    (`calibratedLocalToWorld`) is that placement, because that is what "reset to calibrated" has to go back to. A scan whose
 *    only moves were undone, or whose last one was a reset to its calibration, is such a scan: its log is not empty and nobody
 *    placed it. The moves still holding a reset scan are taken back (`supersedeMoves`), so the editor, which replays the log,
 *    draws it where the server put it.
 *  - A scan a person moved by hand stays exactly where it is. If the georeference now puts it somewhere other than where it
 *    put it before (the placement of the version the world was made under), it is flagged `placementStale`: its position on
 *    Earth is from an older registration. A version that changed nothing for the scan (a registration confirmed with every
 *    number as it was, or the origin moved, which moves the whole scene with it) is nothing to flag. Its
 *    `calibratedLocalToWorld` is the new placement, so that undoing the move lands it where the georeference says. A scan of
 *    another frame (a one-point scan of a two-point Place) is not placed by the georeference, so there is nothing stale about it.
 *  - Things and observations follow the scans that were placed again (`carryThings`).
 *  - A world whose Place no longer has a georeference (it never could erase one: a registration made for another alignment of the
 *    Place is not used, and so is a record a person edited into nonsense) keeps every placement it has, forgets the record it was
 *    made under, and its scans stop saying they are on the map.
 *
 * Returns whether anything changed, so the caller knows to save the world.
 */
export function applyPlaceGeoreference(world: WorldProject, place: PlaceFacts, host: PlacementHost): boolean {
  const stamped = placeGeorefVersion(world)
  const record = place.georeference
  let changed = false

  if (record && stamped !== place.georefVersion) {
    const origin = georeferenceOriginAsGeoPose(record)
    world.originGeoPose = origin
    world.localFrame = { type: 'ENU_Y_UP', origin, units: 'meters', axes: { x: 'east', y: 'up', z: 'south' } }
    world.georeference = record
    world.georefVersion = place.georefVersion
    const ctx = placementContext(world, place, host.maxRadiusM)
    const moves = new Map<string, { from: number[]; to: number[] }>()
    const writtenAt = host.now ? host.now() : new Date().toISOString()
    world.scans.forEach((scan, index) => {
      const facts = placementFactsFor(host, scan.filename)
      if (!facts) return
      const placement = placeSceneScan(facts, ctx, index)
      // What the version this world was made under put the scan at: the placement a move is measured against.
      const before = scan.calibratedLocalToWorld
      const handPlaced = isHandPlaced(world.editPatches, scan)
      const live = liveScanPlacementPatches(world.editPatches, scan)
      scan.calibratedLocalToWorld = placement.matrix
      scan.geoDistanceM = placement.geoDistanceM
      if (handPlaced) {
        // Out of date when the georeference puts the scan somewhere other than where it is, and somewhere other than where it put it
        // when the move was made (the move was made from that placement, so a version that left it alone is no news). A scan of another
        // frame is placed by its own calibration and no georeference carries it: nothing about it is out of date.
        if (placement.source !== null && !sameMatrix(scan.localToWorld, placement.matrix) && !sameMatrix(before, placement.matrix)) scan.placementStale = true
        return
      }
      if (!sameMatrix(scan.localToWorld, placement.matrix)) {
        moves.set(scan.scanId, { from: scan.localToWorld, to: placement.matrix })
        if (live.length > 0) supersedeMoves(world, scan, live, placement.matrix, place.georefVersion, writtenAt)
      }
      scan.localToWorld = placement.matrix
      if (placement.geoOutlier) scan.geoOutlier = true
      else delete scan.geoOutlier
      delete scan.placementStale
      if (placement.source === null) {
        delete scan.placementSource
        delete scan.placementUncertaintyM
      } else {
        scan.placementSource = placement.source
        scan.placementUncertaintyM = placement.uncertaintyM
      }
    })
    carryThings(world, moves)
    return true
  }

  if (record && !sameGeoreference(world.georeference ?? null, record)) {
    world.georeference = record
    changed = true
  }
  if (!record && (world.georeference !== undefined || stamped !== 0)) {
    delete world.georeference
    delete world.georefVersion
    // The scans it placed stay where they are and stop saying they are on the map: nothing registers them now, and a flag that
    // their registration is out of date is about a registration that is gone.
    for (const scan of world.scans) {
      if (scan.placementSource === 'georeference') {
        delete scan.placementSource
        delete scan.placementUncertaintyM
      }
      delete scan.placementStale
    }
    changed = true
  }
  return changed
}

/**
 * A world of the right-handed scene whose origin was never set (no scan had a fix when it was written) takes the origin of its
 * best located scan. Nothing moves: no earlier scan had a fix to be placed by, so every one of them stands on the grid, and the
 * scans added from now on are placed against it. A legacy world is left alone, as every legacy placement is.
 */
export function originIfMissing(
  world: WorldProject,
  place: PlaceFacts,
  candidates: ReadonlyArray<{ geoPose: GeoPose }>,
): boolean {
  if (worldConvention(world) !== 'scene' || place.georeference || hasGeoPose(world.originGeoPose)) return false
  const origin = resolveWorldOrigin(null, candidates)
  if (!origin) return false
  world.originGeoPose = origin
  world.localFrame = { ...world.localFrame, origin }
  return true
}

/**
 * A manifest the world refresh has laid over a stored row, with the row's stamps about how it was placed put back, absent
 * ones included. The refresh keeps the row's `localToWorld`, so a stamp from the freshly built manifest would describe a
 * matrix the row does not hold: a scan the previous build placed has no stamp, and does not gain one by being read again.
 * (A stamp the row can prove, `'place-frame'`, is given by `settleWorldPlacementStamps`.)
 */
export function withStoredPlacementStamps(merged: ScanManifest, row: ScanManifest): ScanManifest {
  for (const key of ['placementSource', 'placementUncertaintyM', 'placementStale'] as const) {
    if (row[key] === undefined) delete merged[key]
    else (merged as unknown as Record<string, unknown>)[key] = row[key]
  }
  return merged
}

/**
 * The stamps of a scan the legacy convention places (a world file that declares `z: 'north'`): the matrix is the one the
 * previous build computed and is not touched, and this says only what put it there. A calibration in the Place's frame is
 * `'place-frame'`; a calibration of another frame is not stamped; a scan with no calibration and a fix inside the radius is
 * `'gps-compass'` with **no uncertainty**: the compass in that world is the phone's own heading at export and the axes are
 * mirrored, so the placement may be many metres out and turned any way, and no figure is one this build can stand behind (the
 * editor flags the world as mirrored); anything else stands on the grid.
 */
export function legacyPlacementStamps(
  facts: ScanPlacementFacts,
  frameMethod: PlaceFacts['frameMethod'],
  placement: { geoDistanceM: number | null; geoOutlier: boolean },
  frameId: PlaceFacts['frameId'] = null,
): Pick<ScanManifest, 'placementSource' | 'placementUncertaintyM'> {
  if (facts.projectTransform) {
    return inFrameOf(facts, { frameMethod, frameId }) ? { placementSource: 'place-frame', placementUncertaintyM: null } : {}
  }
  if (placement.geoDistanceM !== null && !placement.geoOutlier) return { placementSource: 'gps-compass', placementUncertaintyM: null }
  return { placementSource: 'grid', placementUncertaintyM: null }
}

/**
 * Two small corrections to a world's rows, made on every read.
 *
 *  - A calibrated scan that sits exactly at its `projectTransform`, in the Place's frame, and has no stamp, is stamped
 *    `'place-frame'`: that is a fact the matrix and the sidecar prove, and it is what a world file from before the stamps
 *    existed has no way to say. A scan whose placement is not provable (a GPS or grid placement of the previous build) is left
 *    without one, because absence is not a claim.
 *  - A scan flagged `placementStale` whose matrix is its calibrated placement again (it was reset, or the move was undone) is
 *    no longer stale.
 *
 * Returns whether any row changed.
 */
export function settleWorldPlacementStamps(world: WorldProject, place: PlaceFacts, host: PlacementHost): boolean {
  let changed = false
  for (const scan of world.scans) {
    if (scan.placementStale && sameMatrix(scan.localToWorld, scan.calibratedLocalToWorld)) {
      delete scan.placementStale
      changed = true
    }
    if (scan.placementSource === undefined && !place.georeference) {
      const facts = placementFactsFor(host, scan.filename)
      if (facts?.projectTransform && inFrameOf(facts, place) && sameMatrix(scan.localToWorld, facts.projectTransform)) {
        scan.placementSource = 'place-frame'
        scan.placementUncertaintyM = null
        changed = true
      }
    }
  }
  return changed
}

// ─── What server/main.ts calls ───────────────────────────────────────────────

/** What a stored scan's manifest takes from the world's placement: see {@link placeStoredScan}. */
export interface StoredScanPlacement {
  /** The scan's matrix when the world places it (a world of the right-handed scene), else null: the caller keeps the matrix it computed. */
  matrix: number[] | null
  geoDistanceM: number | null
  geoOutlier: boolean
  /** `placementSource` and `placementUncertaintyM`, or nothing when the placement says nothing about the scan. */
  stamps: Pick<ScanManifest, 'placementSource' | 'placementUncertaintyM'>
}

/**
 * The placement part of `scanManifestFromStored` (server/main.ts), for one stored scan. A world of the right-handed scene places it
 * (`placeSceneScan`); a legacy world keeps the matrix and the distance the caller computed as it always did (`legacy`), and only gets
 * the stamps that say what put it there (`legacyPlacementStamps`); with no placement context at all (a caller that has no Place to
 * ask) nothing is said and nothing changes.
 */
export function placeStoredScan(
  world: WorldPlacementContext | undefined,
  meta: Record<string, unknown>,
  geoPose: GeoPose,
  projectTransform: number[] | null,
  legacy: { geoDistanceM: number | null; geoOutlier: boolean },
  index: number,
): StoredScanPlacement {
  if (!world) return { matrix: null, geoDistanceM: legacy.geoDistanceM, geoOutlier: legacy.geoOutlier, stamps: {} }
  const facts = scanPlacementFacts(meta, geoPose, projectTransform)
  const scene = world.convention === 'scene' ? placeSceneScan(facts, world, index) : null
  const decided = scene ?? legacy
  return {
    matrix: scene?.matrix ?? null,
    geoDistanceM: decided.geoDistanceM,
    geoOutlier: decided.geoOutlier,
    stamps: scene ? placementFields(scene) : legacyPlacementStamps(facts, world.frameMethod, legacy, world.frameId),
  }
}

/** What the hooks in server/main.ts hold: the Places registry, a logger, and the readers of a sidecar that main.ts owns. */
export interface WorldPlacingDeps {
  loadProjects: () => Promise<Project[]>
  warn: (message: string) => void
  /** `WORLD_SCAN_MAX_RADIUS_M`: the farthest a scan's fix may be from the origin and still place it. */
  maxRadiusM: number
  geoPoseFor: PlacementHost['geoPoseFor']
  matrixFor: PlacementHost['matrixFor']
}

/**
 * The parts of placement that need what main.ts owns, closed over it once, so that each hook there is a line or two: the facts of a
 * Place or of a world's Place (a georeference the validator refuses is ignored, and the warning is logged once for each reason and
 * Place, not on every read), the context a world's scans are placed under, and the host a refresh hands `applyPlaceGeoreference`.
 */
export function createWorldPlacing(deps: WorldPlacingDeps) {
  const lastIgnored = new Map<string, string>()
  const factsOfProject = (project: Project | null | undefined): PlaceFacts =>
    placeFactsFor(project, (reason) => {
      if (!project || lastIgnored.get(project.projectId) === reason) return
      lastIgnored.set(project.projectId, reason)
      deps.warn(`[worlds] ignoring the georeference of Place ${project.projectId}: ${reason}`)
    })
  return {
    factsOfProject,
    /** The facts of a world's Place, or null when the registry could not be read this moment (a world must not forget its georeference over that). */
    async factsOfWorld(world: WorldProject): Promise<PlaceFacts | null> {
      if (!world.projectId) return placeFactsFor(null)
      try {
        return factsOfProject((await deps.loadProjects()).find((project) => project.projectId === world.projectId))
      } catch (err) {
        deps.warn(`[worlds] could not read the Places registry to place a world: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    },
    context: (world: WorldProject, place: PlaceFacts): WorldPlacementContext => placementContext(world, place, deps.maxRadiusM),
    host: (metaFor: PlacementHost['metaFor']): PlacementHost => ({ maxRadiusM: deps.maxRadiusM, metaFor, geoPoseFor: deps.geoPoseFor, matrixFor: deps.matrixFor }),
  }
}

export type WorldPlacing = ReturnType<typeof createWorldPlacing>
